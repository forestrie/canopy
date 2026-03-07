/**
 * Grant CBOR encode/decode (Plan 0001 Step 1).
 * Uses integer keys for deterministic encoding (content-addressable path).
 */

import { decode as decodeCbor, encode as encodeCbor } from "cbor-x";
import { toBytes, toBytesLength, toNumber } from "../unknown-coercion.js";
import type { Grant } from "./types.js";
import { GRANT_VERSION } from "./types.js";
import { GRANT_FLAGS_BYTES, KIND_BYTES } from "./kinds.js";
import { LOG_ID_BYTES } from "./uuid-bytes.js";

const K = {
  version: 1,
  idtimestamp: 2,
  logId: 3,
  ownerLogId: 4,
  grantFlags: 5,
  maxHeight: 6,
  minGrowth: 7,
  grantData: 8,
  signer: 9,
  kind: 10,
  exp: 11,
  nbf: 12,
} as const;

type CborGrant = Record<number, unknown>;

/**
 * Encode a grant to CBOR bytes (deterministic key order for content-addressable path).
 */
export function encodeGrant(grant: Grant): Uint8Array {
  const map: Record<number, unknown> = {
    [K.version]: grant.version,
    [K.idtimestamp]: grant.idtimestamp,
    [K.logId]: grant.logId,
    [K.ownerLogId]: grant.ownerLogId,
    [K.grantFlags]: grant.grantFlags,
    [K.grantData]: grant.grantData,
    [K.signer]: grant.signer,
    [K.kind]: grant.kind,
  };
  if (grant.maxHeight !== undefined) map[K.maxHeight] = grant.maxHeight;
  if (grant.minGrowth !== undefined) map[K.minGrowth] = grant.minGrowth;
  if (grant.exp !== undefined) map[K.exp] = grant.exp;
  if (grant.nbf !== undefined) map[K.nbf] = grant.nbf;
  return encodeCbor(map, { useFloat32: false });
}

/**
 * Decode CBOR bytes to a Grant. Rejects empty, truncated, unknown version, or missing required fields.
 */
export function decodeGrant(bytes: Uint8Array): Grant {
  if (!bytes || bytes.length === 0) {
    throw new Error("Grant payload is empty");
  }
  let raw: unknown;
  try {
    raw = decodeCbor(bytes);
  } catch (e) {
    throw new Error(
      `Grant decode failed: ${e instanceof Error ? e.message : "truncated or invalid CBOR"}`,
    );
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("Grant payload must be a CBOR map");
  }
  const m = raw as CborGrant;

  const version = toNumber(m[K.version]);
  if (version === undefined) {
    throw new Error("Grant missing required field: version");
  }
  if (version !== GRANT_VERSION) {
    throw new Error(`Grant unknown version: ${version}`);
  }

  const idtimestamp = toBytes(m[K.idtimestamp]);
  if (!idtimestamp || idtimestamp.length !== 8) {
    throw new Error("Grant missing or invalid idtimestamp (must be 8 bytes)");
  }

  const logId = toBytesLength(m[K.logId], LOG_ID_BYTES);
  if (!logId) {
    throw new Error(`Grant missing or invalid logId (must be ${LOG_ID_BYTES} bytes)`);
  }

  const ownerLogId = toBytesLength(m[K.ownerLogId], LOG_ID_BYTES);
  if (!ownerLogId) {
    throw new Error(`Grant missing or invalid ownerLogId (must be ${LOG_ID_BYTES} bytes)`);
  }

  const grantFlags = toBytesLength(m[K.grantFlags], GRANT_FLAGS_BYTES);
  if (!grantFlags) {
    throw new Error(`Grant missing or invalid grantFlags (must be ${GRANT_FLAGS_BYTES} bytes)`);
  }

  const grantData = toBytes(m[K.grantData]);
  if (!grantData) {
    throw new Error("Grant missing required field: grantData");
  }

  const signer = toBytes(m[K.signer]);
  if (!signer || signer.length === 0) {
    throw new Error("Grant missing required field: signer");
  }

  const kind = toBytesLength(m[K.kind], KIND_BYTES);
  if (!kind) {
    throw new Error(`Grant missing or invalid kind (must be ${KIND_BYTES} byte)`);
  }

  const grant: Grant = {
    version,
    idtimestamp,
    logId,
    ownerLogId,
    grantFlags,
    grantData,
    signer,
    kind,
  };

  const maxHeight = toNumber(m[K.maxHeight]);
  if (maxHeight !== undefined) grant.maxHeight = maxHeight;
  const minGrowth = toNumber(m[K.minGrowth]);
  if (minGrowth !== undefined) grant.minGrowth = minGrowth;
  const exp = toNumber(m[K.exp]);
  if (exp !== undefined) grant.exp = exp;
  const nbf = toNumber(m[K.nbf]);
  if (nbf !== undefined) grant.nbf = nbf;

  return grant;
}
