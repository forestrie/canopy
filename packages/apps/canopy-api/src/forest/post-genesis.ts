/**
 * `POST /api/forest/{log-id}/genesis` — validate COSE_Key + private fields, store CBOR in R2_GRANTS.
 * Caller must already enforce {@link curatorAdminBearerOrUnauthorized}.
 */

import { encode as encodeCbor } from "cbor-x";

import {
  COSE_ALG_ES256,
  COSE_CRV_P256,
  COSE_EC2_CRV,
  COSE_EC2_X,
  COSE_EC2_Y,
  COSE_KEY_ALG,
  COSE_KEY_KTY,
  COSE_KTY_EC2,
} from "../cose/cose-key.js";
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
  FOREST_GENESIS_LABEL_BOOTSTRAP_LOG_ID,
  FOREST_GENESIS_LABEL_CHAIN_ID,
  FOREST_GENESIS_LABEL_GENESIS_VERSION,
  FOREST_GENESIS_LABEL_UNIVOCITY_ADDR,
  FOREST_GENESIS_LABEL_UNIVOCITY_CHAIN_IDS,
  FOREST_GENESIS_SCHEMA_V1,
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
  if (version !== FOREST_GENESIS_SCHEMA_V1) {
    return ClientErrors.badRequest("genesis-version must be 1 (-68009)");
  }

  const kty = m.get(COSE_KEY_KTY);
  const crv = m.get(COSE_EC2_CRV);
  const x = asGenesisUint8Array(m.get(COSE_EC2_X));
  const y = asGenesisUint8Array(m.get(COSE_EC2_Y));
  if (kty !== COSE_KTY_EC2 || crv !== COSE_CRV_P256) {
    return ClientErrors.badRequest("COSE_Key must use EC2 / P-256");
  }
  if (!x || x.length !== 32 || !y || y.length !== 32) {
    return ClientErrors.badRequest("Invalid COSE EC2 coordinate lengths");
  }

  const alg = m.get(COSE_KEY_ALG);
  if (alg !== undefined && alg !== COSE_ALG_ES256) {
    return ClientErrors.badRequest("COSE alg must be ES256 (-7) if present");
  }

  const clientBoot = m.get(FOREST_GENESIS_LABEL_BOOTSTRAP_LOG_ID);
  if (clientBoot !== undefined) {
    const b = asGenesisUint8Array(clientBoot);
    if (!b || b.length !== 32 || !bytesEqual(b, paddedWire)) {
      return ClientErrors.badRequest(
        "bootstrap-logid must match path log-id when provided",
      );
    }
  }

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

  const allowed = new Set([
    COSE_KEY_KTY,
    COSE_EC2_CRV,
    COSE_EC2_X,
    COSE_EC2_Y,
    COSE_KEY_ALG,
    FOREST_GENESIS_LABEL_GENESIS_VERSION,
    FOREST_GENESIS_LABEL_BOOTSTRAP_LOG_ID,
    FOREST_GENESIS_LABEL_UNIVOCITY_ADDR,
    FOREST_GENESIS_LABEL_CHAIN_ID,
  ]);
  for (const k of m.keys()) {
    if (!allowed.has(k)) {
      return ClientErrors.badRequest(`Unknown genesis map key ${k}`);
    }
  }

  const out = new Map<number, unknown>();
  out.set(COSE_KEY_KTY, COSE_KTY_EC2);
  out.set(COSE_EC2_CRV, COSE_CRV_P256);
  out.set(COSE_EC2_X, x);
  out.set(COSE_EC2_Y, y);
  out.set(COSE_KEY_ALG, COSE_ALG_ES256);
  out.set(FOREST_GENESIS_LABEL_GENESIS_VERSION, FOREST_GENESIS_SCHEMA_V1);
  out.set(FOREST_GENESIS_LABEL_BOOTSTRAP_LOG_ID, paddedWire);
  out.set(FOREST_GENESIS_LABEL_UNIVOCITY_ADDR, addrRes);
  out.set(FOREST_GENESIS_LABEL_CHAIN_ID, chainId);

  const storageSeg = logIdToStorageSegment(logId);
  const body = encodeCbor(out) as Uint8Array;

  // Forward to the univocity owned store first when configured: it is the
  // authority and verifies genesis.key == on-chain bootstrapConfig(). The local
  // R2 copy below stays authoritative for reads until the subject log's first
  // checkpoint, after which it may be expired (plan-0029).
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
      // Univocity accepted (created) but R2 already has a copy: idempotent, the
      // authoritative store is consistent. Report success.
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
