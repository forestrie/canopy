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
import { logIdToWireBytes, wireLogIdToHex64 } from "../grant/log-id-wire.js";
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
  FOREST_GENESIS_LABEL_UNIVOCITY_ADDR,
  FOREST_GENESIS_LABEL_UNIVOCITY_CHAIN_IDS,
} from "./forest-genesis-labels.js";

export interface PostGenesisEnv {
  R2_GRANTS: R2Bucket;
}

function asUint8Array(v: unknown): Uint8Array | null {
  if (v instanceof Uint8Array) return v;
  if (v instanceof ArrayBuffer) return new Uint8Array(v);
  return null;
}

function parseUnivocityAddr(v: unknown): Uint8Array | null | "invalid" {
  if (v === null || v === undefined) return null;
  const b = asUint8Array(v);
  if (!b) return "invalid";
  if (b.length !== 20) return "invalid";
  return b;
}

function parseChainIds(v: unknown): number[] | null | "invalid" {
  if (v === null || v === undefined) return null;
  if (!Array.isArray(v)) return "invalid";
  if (v.length === 0) return "invalid";
  const out: number[] = [];
  for (const item of v) {
    const n =
      typeof item === "bigint"
        ? Number(item)
        : typeof item === "number"
          ? item
          : Number(item);
    if (!Number.isInteger(n) || n < 0 || n > 0xffffffff) return "invalid";
    out.push(n);
  }
  return out;
}

export async function postForestGenesis(
  request: Request,
  logIdRouteSegment: string,
  env: PostGenesisEnv,
): Promise<Response> {
  const ctErr = requireContentTypeCbor(request);
  if (ctErr) return ctErr;

  let wire: Uint8Array;
  try {
    wire = logIdToWireBytes(logIdRouteSegment);
  } catch {
    return ClientErrors.badRequest("Invalid log-id in path");
  }

  let raw: unknown;
  try {
    raw = await parseCborBody(request);
  } catch {
    return ClientErrors.badRequest("Invalid CBOR body");
  }

  const m = decodeBodyAsIntKeyMap(raw);
  if (!m) return ClientErrors.badRequest("Genesis body must be a CBOR map");

  const kty = m.get(COSE_KEY_KTY);
  const crv = m.get(COSE_EC2_CRV);
  const x = asUint8Array(m.get(COSE_EC2_X));
  const y = asUint8Array(m.get(COSE_EC2_Y));
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
    const b = asUint8Array(clientBoot);
    if (!b || b.length !== 32 || !bytesEqual(b, wire)) {
      return ClientErrors.badRequest(
        "bootstrap-logid must match path log-id when provided",
      );
    }
  }

  const addrRes = parseUnivocityAddr(
    m.get(FOREST_GENESIS_LABEL_UNIVOCITY_ADDR),
  );
  if (addrRes === "invalid") {
    return ClientErrors.badRequest(
      "univocity-addr must be null or a 20-byte bstr",
    );
  }

  const chainRes = parseChainIds(
    m.get(FOREST_GENESIS_LABEL_UNIVOCITY_CHAIN_IDS),
  );
  if (chainRes === "invalid") {
    return ClientErrors.badRequest(
      "univocity-chainids must be null or a non-empty array of uint32",
    );
  }

  const allowed = new Set([
    COSE_KEY_KTY,
    COSE_EC2_CRV,
    COSE_EC2_X,
    COSE_EC2_Y,
    COSE_KEY_ALG,
    FOREST_GENESIS_LABEL_BOOTSTRAP_LOG_ID,
    FOREST_GENESIS_LABEL_UNIVOCITY_ADDR,
    FOREST_GENESIS_LABEL_UNIVOCITY_CHAIN_IDS,
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
  out.set(FOREST_GENESIS_LABEL_BOOTSTRAP_LOG_ID, wire);
  out.set(
    FOREST_GENESIS_LABEL_UNIVOCITY_ADDR,
    addrRes === null ? null : addrRes,
  );
  out.set(
    FOREST_GENESIS_LABEL_UNIVOCITY_CHAIN_IDS,
    chainRes === null ? null : chainRes,
  );

  const key = `forest/${wireLogIdToHex64(wire)}/genesis.cbor`;
  const head = await env.R2_GRANTS.head(key);
  if (head) {
    return ClientErrors.conflict("genesis.cbor already exists for this log");
  }

  const body = encodeCbor(out) as Uint8Array;
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
