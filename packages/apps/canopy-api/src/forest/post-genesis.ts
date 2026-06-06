/**
 * `POST /api/forest/{log-id}/genesis` — validate COSE_Key + private fields, store CBOR in R2_GRANTS.
 * Caller must already enforce {@link curatorAdminBearerOrUnauthorized}.
 */

import { encode as encodeCbor } from "cbor-x";

import { COSE_ALG_ES256, COSE_ALG_KS256 } from "../cose/cose-key.js";
import {
  logIdToStorageSegment,
  logIdToWireBytes,
  toPaddedWire32,
} from "../grant/log-id-wire.js";
import { parseCborBody } from "../cbor-api/cbor-request.js";
import {
  cborResponse,
  requireContentTypeCbor,
} from "../cbor-api/cbor-response.js";
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
  FOREST_GENESIS_SCHEMA_V2,
} from "./forest-genesis-labels.js";
import {
  asGenesisUint8Array,
  parseChainIdString,
  parseUnivocityAddrRequired,
} from "./genesis-wire.js";
import {
  postGenesisToUnivocity,
  type UnivocityGenesisClient,
} from "./univocity-genesis-client.js";

export interface PostGenesisEnv {
  R2_GRANTS: R2Bucket;
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

function validateChainBinding(m: Map<number, unknown>):
  | {
      addr: Uint8Array;
      chainId: string;
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
  return { addr: addrRes, chainId };
}

function buildV2GenesisOut(
  m: Map<number, unknown>,
  paddedWire: Uint8Array,
  binding: { addr: Uint8Array; chainId: string },
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
  return out;
}

export async function postForestGenesis(
  request: Request,
  logIdRouteSegment: string,
  env: PostGenesisEnv,
): Promise<Response> {
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

  const binding = validateChainBinding(m);
  if (binding instanceof Response) return binding;

  const out = buildV2GenesisOut(m, paddedWire, binding);
  if (out instanceof Response) return out;

  const storageSeg = logIdToStorageSegment(logId);
  const body = encodeCbor(out) as Uint8Array;

  const univocity = univocityGenesisClientFromEnv(env);
  if (univocity) {
    const fwd = await postGenesisToUnivocity(univocity, storageSeg, body);
    if (fwd.kind === "exists") {
      return ClientErrors.conflict("genesis already exists for this log");
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
    if (univocity) {
      return cborResponse({}, 201);
    }
    return ClientErrors.conflict("genesis.cbor already exists for this log");
  }

  try {
    await env.R2_GRANTS.put(key, body);
  } catch (e) {
    return ServerErrors.storageError(
      e instanceof Error ? e.message : String(e),
      "R2_GRANTS.put",
    );
  }

  return cborResponse({}, 201);
}
