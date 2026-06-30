/**
 * `POST /api/forest/{log-id}/genesis` — validate COSE_Key + private fields, store CBOR in R2_GRANTS.
 * Caller must already enforce {@link curatorAdminBearerOrUnauthorized}.
 */

import { encode as encodeCbor } from "cbor-x";
import type { Address } from "viem";

import { COSE_ALG_ES256, COSE_ALG_KS256 } from "../cose/cose-key.js";
import {
  logIdToStorageSegment,
  logIdToWireBytes,
  toPaddedWire32,
} from "../grant/log-id-wire.js";
import { parseCborBody } from "../cbor-api/cbor-request.js";
import { requireContentTypeCbor } from "../cbor-api/cbor-response.js";
import { ClientErrors, ServerErrors } from "../cbor-api/problem-details.js";
import {
  decodeBodyAsIntKeyMap,
  bytesEqual,
} from "../cbor-api/cbor-map-utils.js";
import {
  FOREST_GENESIS_LABEL_BOOTSTRAP_KEY,
  FOREST_GENESIS_LABEL_BOOTSTRAP_LOG_ID,
  FOREST_GENESIS_LABEL_CHAIN_ID,
  FOREST_GENESIS_LABEL_GENESIS_ALG,
  FOREST_GENESIS_LABEL_GENESIS_VERSION,
  FOREST_GENESIS_LABEL_UNIVOCITY_ADDR,
  FOREST_GENESIS_LABEL_UNIVOCITY_CHAIN_IDS,
  FOREST_GENESIS_LABEL_UNIVOCITY_DEPLOYER,
  FOREST_GENESIS_LABEL_UNIVOCITY_VARIANT,
  FOREST_GENESIS_SCHEMA_V2,
  FOREST_GENESIS_UNIVOCITY_VARIANT_UUPS_COUNTERFACTUAL,
} from "./forest-genesis-labels.js";
import {
  assertCounterfactualUupsAddress,
  parseUnivocityDeployerRequired,
  resolveCreate3FactoryAddress,
} from "./uups-genesis-binding.js";
import {
  asGenesisUint8Array,
  parseChainIdString,
  parseUnivocityAddrRequired,
  type ForestGenesisChainBinding,
} from "./genesis-wire.js";
import { isSupportedChainIdForEnv } from "../env/supported-chains-for-env.js";
import type { SupportedChainsEnv } from "../env/supported-chains-for-env.js";
import {
  postGenesisToUnivocity,
  type UnivocityGenesisClient,
} from "./univocity-genesis-client.js";

export interface PostGenesisEnv extends SupportedChainsEnv {
  R2_GRANTS: R2Bucket;
  /** CREATE3 factory for uups-counterfactual address re-derivation (optional). */
  CREATE3_FACTORY_ADDRESS?: string;
  /**
   * When set, the canonical genesis is forwarded to the univocity owned store,
   * which anchors genesis.key to the on-chain bootstrapConfig(). Canopy also
   * keeps a local R2 copy: it is authoritative for reads until the subject
   * log's first checkpoint is published, after which it may be expired. Sourced
   * from UNIVOCITY_SERVICE_URL + UNIVOCITY_API_TOKEN.
   */
  UNIVOCITY_SERVICE_URL?: string;
  UNIVOCITY_API_TOKEN?: string;
}

function univocityGenesisClientFromEnv(
  env: PostGenesisEnv,
): UnivocityGenesisClient | undefined {
  const serviceUrl = env.UNIVOCITY_SERVICE_URL?.trim();
  const token = env.UNIVOCITY_API_TOKEN?.trim();
  if (!serviceUrl || !token) return undefined;
  return { serviceUrl, token };
}

const V2_KEYS = new Set([
  FOREST_GENESIS_LABEL_GENESIS_VERSION,
  FOREST_GENESIS_LABEL_GENESIS_ALG,
  FOREST_GENESIS_LABEL_BOOTSTRAP_KEY,
  FOREST_GENESIS_LABEL_BOOTSTRAP_LOG_ID,
  FOREST_GENESIS_LABEL_UNIVOCITY_ADDR,
  FOREST_GENESIS_LABEL_CHAIN_ID,
  FOREST_GENESIS_LABEL_UNIVOCITY_VARIANT,
  FOREST_GENESIS_LABEL_UNIVOCITY_DEPLOYER,
]);

function parseGenesisAlg(raw: unknown): number | "invalid" {
  if (typeof raw === "number" && Number.isInteger(raw)) return raw;
  if (typeof raw === "bigint") {
    const n = Number(raw);
    return Number.isSafeInteger(n) ? n : "invalid";
  }
  return "invalid";
}

function validateBootstrapLogId(
  m: Map<number, unknown>,
  paddedWire: Uint8Array,
): Response | null {
  const clientBoot = m.get(FOREST_GENESIS_LABEL_BOOTSTRAP_LOG_ID);
  if (clientBoot !== undefined) {
    const b = asGenesisUint8Array(clientBoot);
    if (!b || b.length !== 32 || !bytesEqual(b, paddedWire)) {
      return ClientErrors.badRequest(
        "bootstrap-logid must match path log-id when provided",
      );
    }
  }
  return null;
}

function validateChainBinding(
  m: Map<number, unknown>,
  logIdRouteSegment: string,
  create3Factory: Address,
):
  | {
      addr: Uint8Array;
      chainId: string;
      variant?: string;
      deployer?: Uint8Array;
    }
  | Response {
  const addrRes = parseUnivocityAddrRequired(
    m.get(FOREST_GENESIS_LABEL_UNIVOCITY_ADDR),
  );
  if (addrRes === "invalid") {
    return ClientErrors.badRequest("univocity-addr must be a 20-byte bstr");
  }
  const chainId = parseChainIdString(m.get(FOREST_GENESIS_LABEL_CHAIN_ID));
  if (chainId === "invalid") {
    return ClientErrors.badRequest(
      "chain-id must be a non-empty decimal EIP-155 id string (-68013)",
    );
  }

  const variantRaw = m.get(FOREST_GENESIS_LABEL_UNIVOCITY_VARIANT);
  if (variantRaw === undefined) {
    return { addr: addrRes, chainId };
  }
  if (typeof variantRaw !== "string") {
    return ClientErrors.badRequest("univocity-variant must be a text string");
  }
  if (variantRaw !== FOREST_GENESIS_UNIVOCITY_VARIANT_UUPS_COUNTERFACTUAL) {
    return ClientErrors.badRequest(
      `unsupported univocity-variant ${JSON.stringify(variantRaw)}`,
    );
  }

  const deployer = parseUnivocityDeployerRequired(
    m.get(FOREST_GENESIS_LABEL_UNIVOCITY_DEPLOYER),
  );
  if (deployer === "invalid") {
    return ClientErrors.badRequest(
      "univocity-deployer (-68017) must be a 20-byte bstr for uups-counterfactual",
    );
  }

  if (
    !assertCounterfactualUupsAddress(
      logIdRouteSegment,
      deployer,
      addrRes,
      create3Factory,
    )
  ) {
    return ClientErrors.badRequest(
      "univocity-addr does not match counterfactual CREATE3 address for log-id and deployer",
    );
  }

  return {
    addr: addrRes,
    chainId,
    variant: variantRaw,
    deployer,
  };
}

function buildV2GenesisOut(
  m: Map<number, unknown>,
  paddedWire: Uint8Array,
  binding: {
    addr: Uint8Array;
    chainId: string;
    variant?: string;
    deployer?: Uint8Array;
  },
): Map<number, unknown> | Response {
  const genesisAlg = parseGenesisAlg(m.get(FOREST_GENESIS_LABEL_GENESIS_ALG));
  if (genesisAlg === "invalid") {
    return ClientErrors.badRequest(
      "genesisAlg (-68014) must be ES256 (-7) or KS256 (-65799)",
    );
  }
  const bootstrapKey = asGenesisUint8Array(
    m.get(FOREST_GENESIS_LABEL_BOOTSTRAP_KEY),
  );
  if (!bootstrapKey) {
    return ClientErrors.badRequest(
      "bootstrapKey (-68015) must be a byte string",
    );
  }
  if (genesisAlg === COSE_ALG_ES256 && bootstrapKey.length !== 64) {
    return ClientErrors.badRequest(
      "ES256 bootstrapKey must be 64 bytes (x||y)",
    );
  }
  if (genesisAlg === COSE_ALG_KS256 && bootstrapKey.length !== 20) {
    return ClientErrors.badRequest(
      "KS256 bootstrapKey must be a 20-byte address",
    );
  }
  if (genesisAlg !== COSE_ALG_ES256 && genesisAlg !== COSE_ALG_KS256) {
    return ClientErrors.badRequest(
      "genesisAlg must be ES256 (-7) or KS256 (-65799)",
    );
  }
  for (const k of m.keys()) {
    if (!V2_KEYS.has(k)) {
      return ClientErrors.badRequest(`Unknown genesis map key ${k}`);
    }
  }
  const out = new Map<number, unknown>();
  out.set(FOREST_GENESIS_LABEL_GENESIS_VERSION, FOREST_GENESIS_SCHEMA_V2);
  out.set(FOREST_GENESIS_LABEL_GENESIS_ALG, genesisAlg);
  out.set(FOREST_GENESIS_LABEL_BOOTSTRAP_KEY, bootstrapKey);
  out.set(FOREST_GENESIS_LABEL_BOOTSTRAP_LOG_ID, paddedWire);
  out.set(FOREST_GENESIS_LABEL_UNIVOCITY_ADDR, binding.addr);
  out.set(FOREST_GENESIS_LABEL_CHAIN_ID, binding.chainId);
  if (binding.variant !== undefined) {
    out.set(FOREST_GENESIS_LABEL_UNIVOCITY_VARIANT, binding.variant);
  }
  if (binding.deployer !== undefined) {
    out.set(FOREST_GENESIS_LABEL_UNIVOCITY_DEPLOYER, binding.deployer);
  }
  return out;
}

export interface PostGenesisSuccess {
  logIdWire: Uint8Array;
  storageSeg: string;
  chainBinding: ForestGenesisChainBinding;
  genesisAlg: number;
  bootstrapKey: Uint8Array;
  /** True when genesis already existed (idempotent 201). */
  alreadyExisted: boolean;
}

export async function postForestGenesis(
  request: Request,
  logIdRouteSegment: string,
  env: PostGenesisEnv,
): Promise<PostGenesisSuccess | Response> {
  const ctErr = requireContentTypeCbor(request);
  if (ctErr) return ctErr;

  let logId: Uint8Array;
  try {
    logId = logIdToWireBytes(logIdRouteSegment);
  } catch {
    return ClientErrors.badRequest("Invalid log-id in path");
  }
  const paddedWire = toPaddedWire32(logId);

  let raw: unknown;
  try {
    raw = await parseCborBody(request);
  } catch {
    return ClientErrors.badRequest("Invalid CBOR body");
  }

  const m = decodeBodyAsIntKeyMap(raw);
  if (!m) return ClientErrors.badRequest("Genesis body must be a CBOR map");

  if (m.has(FOREST_GENESIS_LABEL_UNIVOCITY_CHAIN_IDS)) {
    return ClientErrors.badRequest(
      "univocity-chainids (-68012) is legacy; use chain-id (-68013)",
    );
  }

  const version = m.get(FOREST_GENESIS_LABEL_GENESIS_VERSION);
  if (version !== FOREST_GENESIS_SCHEMA_V2) {
    return ClientErrors.badRequest("genesis-version must be 2 (-68009)");
  }

  const bootErr = validateBootstrapLogId(m, paddedWire);
  if (bootErr) return bootErr;

  const binding = validateChainBinding(
    m,
    logIdRouteSegment,
    resolveCreate3FactoryAddress(env),
  );
  if (binding instanceof Response) return binding;

  if (!isSupportedChainIdForEnv(env, binding.chainId)) {
    return ClientErrors.badRequest(
      `chain-id ${binding.chainId} is not supported by this canopy deployment`,
    );
  }

  const out = buildV2GenesisOut(m, paddedWire, binding);
  if (out instanceof Response) return out;

  const genesisAlg = out.get(FOREST_GENESIS_LABEL_GENESIS_ALG);
  const bootstrapKey = out.get(FOREST_GENESIS_LABEL_BOOTSTRAP_KEY);
  if (typeof genesisAlg !== "number" || !(bootstrapKey instanceof Uint8Array)) {
    return ClientErrors.badRequest("genesisAlg and bootstrapKey are required");
  }

  const storageSeg = logIdToStorageSegment(logId);
  const body = encodeCbor(out) as Uint8Array;
  const chainBinding: ForestGenesisChainBinding = {
    address: binding.addr,
    chainId: binding.chainId,
  };

  const univocity = univocityGenesisClientFromEnv(env);
  if (univocity) {
    const fwd = await postGenesisToUnivocity(univocity, storageSeg, body);
    if (fwd.kind === "exists") {
      return {
        logIdWire: logId,
        storageSeg,
        chainBinding,
        genesisAlg,
        bootstrapKey,
        alreadyExisted: true,
      };
    }
    if (fwd.kind === "rejected") {
      return ClientErrors.badRequest(
        fwd.detail || "univocity rejected the genesis document",
      );
    }
    if (fwd.kind === "unavailable") {
      return ServerErrors.serviceUnavailable(
        fwd.detail || "univocity genesis store is unavailable",
      );
    }
  }

  const key = `forests/forest/${storageSeg}/genesis.cbor`;
  const head = await env.R2_GRANTS.head(key);
  if (head) {
    return {
      logIdWire: logId,
      storageSeg,
      chainBinding,
      genesisAlg,
      bootstrapKey,
      alreadyExisted: true,
    };
  }

  try {
    await env.R2_GRANTS.put(key, body);
  } catch (e) {
    return ServerErrors.storageError(
      e instanceof Error ? e.message : String(e),
      "R2_GRANTS.put",
    );
  }

  return {
    logIdWire: logId,
    storageSeg,
    chainBinding,
    genesisAlg,
    bootstrapKey,
    alreadyExisted: false,
  };
}
