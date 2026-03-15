/**
 * Grant CBOR encode/decode aligned with go-univocity wire format (Plan 0004 subplan 01, Plan 0006).
 *
 * **Grant content (canonical):** CBOR map with integer keys 1–8 only (logId, ownerLogId, grantFlags,
 * maxHeight, minGrowth, grantData, signer, kind). Idtimestamp is never part of the canonical
 * content encoding; it is supplied separately where needed (e.g. header -65537, massif, leaf hash).
 *
 * **Response format (keys 0–8):** Used when encoding a completed grant for GET response only.
 * Storage uses content only (1–8).
 */

import { decode as decodeCbor, encode as encodeCbor } from "cbor-x";
import type { Grant } from "./grant.js";
import { GRANT_VERSION } from "./grant.js";

/**
 * Wire format constants (go-univocity aligned).
 * - CBOR_KEY_*: map key numbers (semantics). Keys 0–8 for response; 1–8 only for content.
 * - CBOR_BSTR_*: CBOR encoding bytes for our fixed-length bstrs (0x48 = bstr len 8, 0x58 = bstr with 1-byte length).
 */
const CBOR_KEY_IDTIMESTAMP = 0;
const CBOR_KEY_LOG_ID = 1;
const CBOR_KEY_OWNER_LOG_ID = 2;
const CBOR_KEY_GRANT_FLAGS = 3;
const CBOR_KEY_MAX_HEIGHT = 4;
const CBOR_KEY_MIN_GROWTH = 5;
const CBOR_KEY_GRANT_DATA = 6;
const CBOR_KEY_SIGNER = 7;
const CBOR_KEY_KIND = 8;

const WIRE_LOG_ID_OWNER_LOG_ID_BYTES = 32;
const WIRE_GRANT_FLAGS_BYTES = 8;
const IDTIMESTAMP_BYTES = 8;

const CBOR_BSTR_LEN_8 = 0x48;   // bstr, length 8
const CBOR_BSTR_LEN32_LEAD = 0x58; // bstr, length in next byte

// --- Public API (entry points) ---

/**
 * Encode grant content + idtimestamp as CBOR (keys 0–8) for response only (e.g. GET /grants/authority/{innerHex}).
 * Grant has no idtimestamp; it is passed separately.
 */
export function encodeGrantForResponse(
  grant: Grant,
  idtimestamp: Uint8Array,
): Uint8Array {
  const idts =
    idtimestamp.length === IDTIMESTAMP_BYTES
      ? idtimestamp
      : leftPad(idtimestamp, IDTIMESTAMP_BYTES);
  const logId32 = leftPad(
    grant.logId as Uint8Array,
    WIRE_LOG_ID_OWNER_LOG_ID_BYTES,
  );
  const ownerLogId32 = leftPad(
    grant.ownerLogId as Uint8Array,
    WIRE_LOG_ID_OWNER_LOG_ID_BYTES,
  );
  const flags8 = leftPad(
    grant.grantFlags as Uint8Array,
    WIRE_GRANT_FLAGS_BYTES,
  );
  const maxHeight = grant.maxHeight ?? 0;
  const minGrowth = grant.minGrowth ?? 0;
  const grantData = grant.grantData ?? new Uint8Array(0);
  const signer = grant.signer ?? new Uint8Array(0);
  const kindByte =
    grant.kind instanceof Uint8Array && grant.kind.length > 0
      ? grant.kind[0]!
      : 0;

  const b: number[] = [];
  b.push(0xa9); // map(9) — keys 0–8
  b.push(CBOR_KEY_IDTIMESTAMP, CBOR_BSTR_LEN_8);
  for (let i = 0; i < IDTIMESTAMP_BYTES; i++) b.push(idts[i]!);
  b.push(CBOR_KEY_LOG_ID, CBOR_BSTR_LEN32_LEAD, WIRE_LOG_ID_OWNER_LOG_ID_BYTES);
  for (let i = 0; i < WIRE_LOG_ID_OWNER_LOG_ID_BYTES; i++) b.push(logId32[i]!);
  b.push(CBOR_KEY_OWNER_LOG_ID, CBOR_BSTR_LEN32_LEAD, WIRE_LOG_ID_OWNER_LOG_ID_BYTES);
  for (let i = 0; i < WIRE_LOG_ID_OWNER_LOG_ID_BYTES; i++)
    b.push(ownerLogId32[i]!);
  b.push(CBOR_KEY_GRANT_FLAGS, CBOR_BSTR_LEN_8);
  for (let i = 0; i < WIRE_GRANT_FLAGS_BYTES; i++) b.push(flags8[i]!);
  b.push(CBOR_KEY_MAX_HEIGHT);
  appendCborUint(b, maxHeight);
  b.push(CBOR_KEY_MIN_GROWTH);
  appendCborUint(b, minGrowth);
  b.push(CBOR_KEY_GRANT_DATA);
  appendCborBstr(b, grantData);
  b.push(CBOR_KEY_SIGNER);
  appendCborBstr(b, signer);
  b.push(CBOR_KEY_KIND);
  appendCborUint(b, kindByte);
  return new Uint8Array(b);
}

/**
 * Decode CBOR response bytes (keys 0–8) into grant and idtimestamp.
 * Use when reading a GET grant response or any 0–8 blob.
 */
export function decodeGrantResponse(bytes: Uint8Array): {
  grant: Grant;
  idtimestamp: Uint8Array;
} {
  if (!bytes?.length) throw new Error("Grant payload is empty");
  const raw = decodeCbor(bytes) as unknown;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw))
    throw new Error("Grant payload must be a CBOR map");
  const m = raw as Map<number, unknown> | Record<number, unknown>;
  const get = (k: number): unknown =>
    m instanceof Map ? m.get(k) : (m as Record<number, unknown>)[k];

  const idtimestampVal = get(CBOR_KEY_IDTIMESTAMP);
  if (!(idtimestampVal instanceof Uint8Array) || idtimestampVal.length < IDTIMESTAMP_BYTES) {
    throw new Error("Grant response: key 0 must be 8-byte bstr");
  }
  const idtimestamp = new Uint8Array(IDTIMESTAMP_BYTES);
  idtimestamp.set(
    idtimestampVal.length === IDTIMESTAMP_BYTES
      ? idtimestampVal
      : idtimestampVal.slice(-IDTIMESTAMP_BYTES),
  );

  return {
    grant: mapToGrant(m),
    idtimestamp,
  };
}

/**
 * Encode grant as payload only (CBOR map keys 1–8, no idtimestamp).
 * Used when building a transparent statement (e.g. bootstrap) where idtimestamp is in header -65537.
 */
export function encodeGrantPayload(grant: Grant): Uint8Array {
  const logId32 = leftPad(
    grant.logId as Uint8Array,
    WIRE_LOG_ID_OWNER_LOG_ID_BYTES,
  );
  const ownerLogId32 = leftPad(
    grant.ownerLogId as Uint8Array,
    WIRE_LOG_ID_OWNER_LOG_ID_BYTES,
  );
  const flags8 = leftPad(
    grant.grantFlags as Uint8Array,
    WIRE_GRANT_FLAGS_BYTES,
  );
  const grantData = grant.grantData ?? new Uint8Array(0);
  const signer = grant.signer ?? new Uint8Array(0);
  const kindByte =
    grant.kind instanceof Uint8Array && grant.kind.length > 0
      ? grant.kind[0]!
      : 0;
  const m = new Map<number, unknown>([
    [CBOR_KEY_LOG_ID, logId32],
    [CBOR_KEY_OWNER_LOG_ID, ownerLogId32],
    [CBOR_KEY_GRANT_FLAGS, flags8],
    [CBOR_KEY_MAX_HEIGHT, grant.maxHeight ?? 0],
    [CBOR_KEY_MIN_GROWTH, grant.minGrowth ?? 0],
    [CBOR_KEY_GRANT_DATA, grantData],
    [CBOR_KEY_SIGNER, signer],
    [CBOR_KEY_KIND, kindByte],
  ]);
  return new Uint8Array(encodeCbor(m));
}

/**
 * Decode grant payload (CBOR map keys 1–8 only). Returns Grant (content only); idtimestamp from header -65537.
 */
export function decodeGrantPayload(bytes: Uint8Array): Grant {
  if (!bytes?.length) throw new Error("Grant payload is empty");
  const raw = decodeCbor(bytes) as unknown;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw))
    throw new Error("Grant payload must be a CBOR map");
  return mapToGrant(raw as Map<number, unknown> | Record<number, unknown>);
}

// --- Internal helpers ---

function mapToGrant(m: Map<number, unknown> | Record<number, unknown>): Grant {
  const get = (k: number): unknown =>
    m instanceof Map ? m.get(k) : (m as Record<number, unknown>)[k];

  const requireBstr = (v: unknown, minLen = 0): Uint8Array => {
    if (!(v instanceof Uint8Array))
      throw new Error("Grant payload: value must be bstr");
    if (v.length < minLen) throw new Error("Grant payload: bstr too short");
    return v;
  };
  const requireUint = (v: unknown): number => {
    if (typeof v === "number" && Number.isInteger(v)) return v;
    if (typeof v === "bigint") return Number(v);
    throw new Error("Grant payload: expected uint");
  };

  const logId = leftPad(
    requireBstr(get(CBOR_KEY_LOG_ID)),
    WIRE_LOG_ID_OWNER_LOG_ID_BYTES,
  );
  const ownerLogId = leftPad(
    requireBstr(get(CBOR_KEY_OWNER_LOG_ID)),
    WIRE_LOG_ID_OWNER_LOG_ID_BYTES,
  );
  const grantFlags = leftPad(
    requireBstr(get(CBOR_KEY_GRANT_FLAGS)),
    WIRE_GRANT_FLAGS_BYTES,
  );
  const maxHeight = requireUint(get(CBOR_KEY_MAX_HEIGHT));
  const minGrowth = requireUint(get(CBOR_KEY_MIN_GROWTH));
  const grantDataRaw = get(CBOR_KEY_GRANT_DATA);
  const grantData =
    grantDataRaw instanceof Uint8Array
      ? grantDataRaw
      : new Uint8Array(0);
  const signer = requireBstr(get(CBOR_KEY_SIGNER), 1);
  const kindNum = requireUint(get(CBOR_KEY_KIND));
  if (kindNum > 255) throw new Error("Grant: kind exceeds 255");
  const kind = new Uint8Array([kindNum]);

  return {
    version: GRANT_VERSION,
    logId,
    ownerLogId,
    grantFlags,
    maxHeight,
    minGrowth,
    grantData,
    signer,
    kind,
  };
}

function leftPad(b: Uint8Array, length: number): Uint8Array {
  if (b.length >= length) {
    return b.length === length ? b : b.slice(-length);
  }
  const out = new Uint8Array(length);
  out.set(b, length - b.length);
  return out;
}

function appendCborUint(b: number[], v: number): void {
  if (v < 24) b.push(v);
  else if (v <= 0xff) b.push(0x18, v);
  else if (v <= 0xffff) {
    b.push(0x19, (v >> 8) & 0xff, v & 0xff);
  } else if (v <= 0xffffffff) {
    b.push(0x1a, (v >> 24) & 0xff, (v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff);
  } else {
    const lo = v >>> 0;
    const hi = (v / 0x100000000) >>> 0;
    b.push(
      0x1b,
      (hi >> 24) & 0xff,
      (hi >> 16) & 0xff,
      (hi >> 8) & 0xff,
      hi & 0xff,
      (lo >> 24) & 0xff,
      (lo >> 16) & 0xff,
      (lo >> 8) & 0xff,
      lo & 0xff,
    );
  }
}

function appendCborBstr(b: number[], s: Uint8Array): void {
  const n = s.length;
  if (n < 24) b.push(0x40 | n);
  else if (n <= 0xff) b.push(CBOR_BSTR_LEN32_LEAD, n);
  else if (n <= 0xffff) {
    b.push(0x59, (n >> 8) & 0xff, n & 0xff);
  } else {
    b.push(0x5a, (n >> 24) & 0xff, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff);
  }
  for (let i = 0; i < n; i++) b.push(s[i]!);
}
