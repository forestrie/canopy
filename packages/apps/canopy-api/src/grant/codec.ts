/**
 * Grant CBOR encode/decode (Forestrie-Grant **v0**): map keys **1–6** only — `logId`, `ownerLogId`,
 * `grant` (flags), `maxHeight`, `minGrowth`, `grantData`. No `signer` (7), `kind` (8), `version`,
 * `exp`, or `nbf` on the wire; idtimestamp is never in this map.
 *
 * **Response format (keys 0–6):** key 0 = idtimestamp; keys 1–6 = grant fields. Used for GET
 * response encoding only.
 */

import { decode as decodeCbor, encode as encodeCbor } from "cbor-x";
import type { Grant } from "./grant.js";
import { grantDataToBytes } from "./grant-data.js";

const CBOR_KEY_IDTIMESTAMP = 0;
const CBOR_KEY_LOG_ID = 1;
const CBOR_KEY_OWNER_LOG_ID = 2;
const CBOR_KEY_GRANT_FLAGS = 3;
const CBOR_KEY_MAX_HEIGHT = 4;
const CBOR_KEY_MIN_GROWTH = 5;
const CBOR_KEY_GRANT_DATA = 6;

const WIRE_LOG_ID_OWNER_LOG_ID_BYTES = 32;
const WIRE_GRANT_FLAGS_BYTES = 8;
const IDTIMESTAMP_BYTES = 8;

const CBOR_BSTR_LEN_8 = 0x48;
const CBOR_BSTR_LEN32_LEAD = 0x58;

function assertNoObsoleteWireKeys(
  m: Map<number, unknown> | Record<number, unknown>,
): void {
  const keys =
    m instanceof Map
      ? [...m.keys()]
      : Object.keys(m as Record<string, unknown>)
          .map(Number)
          .filter((n) => Number.isFinite(n));
  for (const k of keys) {
    if (k === 7 || k === 8) {
      throw new Error(
        "Grant wire v0: obsolete CBOR keys 7 (signer) and 8 (kind) must not be present; use grantData in the commitment only.",
      );
    }
  }
}

// --- Public API (entry points) ---

/**
 * Encode grant content + idtimestamp as CBOR (keys 0–6) for response only.
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
  const flags8 = leftPad(grant.grant as Uint8Array, WIRE_GRANT_FLAGS_BYTES);
  const maxHeight = grant.maxHeight ?? 0;
  const minGrowth = grant.minGrowth ?? 0;
  const grantData = grantDataToBytes(grant.grantData ?? new Uint8Array(0));

  const b: number[] = [];
  b.push(0xa7); // map(7) — keys 0–6
  b.push(CBOR_KEY_IDTIMESTAMP, CBOR_BSTR_LEN_8);
  for (let i = 0; i < IDTIMESTAMP_BYTES; i++) b.push(idts[i]!);
  b.push(CBOR_KEY_LOG_ID, CBOR_BSTR_LEN32_LEAD, WIRE_LOG_ID_OWNER_LOG_ID_BYTES);
  for (let i = 0; i < WIRE_LOG_ID_OWNER_LOG_ID_BYTES; i++) b.push(logId32[i]!);
  b.push(
    CBOR_KEY_OWNER_LOG_ID,
    CBOR_BSTR_LEN32_LEAD,
    WIRE_LOG_ID_OWNER_LOG_ID_BYTES,
  );
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
  return new Uint8Array(b);
}

/** Decode CBOR response bytes (keys 0–6). */
export function decodeGrantResponse(bytes: Uint8Array): {
  grant: Grant;
  idtimestamp: Uint8Array;
} {
  if (!bytes?.length) throw new Error("Grant payload is empty");
  const raw = decodeCbor(bytes) as unknown;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw))
    throw new Error("Grant payload must be a CBOR map");
  const m = raw as Map<number, unknown> | Record<number, unknown>;
  assertNoObsoleteWireKeys(m);

  const get = (k: number): unknown =>
    m instanceof Map ? m.get(k) : (m as Record<number, unknown>)[k];

  const idtimestampVal = get(CBOR_KEY_IDTIMESTAMP);
  if (
    !(idtimestampVal instanceof Uint8Array) ||
    idtimestampVal.length < IDTIMESTAMP_BYTES
  ) {
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
 * Encode grant as payload only (CBOR map keys 1–6, no idtimestamp).
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
  const flags8 = leftPad(grant.grant as Uint8Array, WIRE_GRANT_FLAGS_BYTES);
  const grantData = grantDataToBytes(grant.grantData ?? new Uint8Array(0));
  const map = new Map<number, unknown>([
    [CBOR_KEY_LOG_ID, logId32],
    [CBOR_KEY_OWNER_LOG_ID, ownerLogId32],
    [CBOR_KEY_GRANT_FLAGS, flags8],
    [CBOR_KEY_MAX_HEIGHT, grant.maxHeight ?? 0],
    [CBOR_KEY_MIN_GROWTH, grant.minGrowth ?? 0],
    [CBOR_KEY_GRANT_DATA, grantData],
  ]);
  return new Uint8Array(encodeCbor(map));
}

/** Decode grant payload (CBOR map keys 1–6 only). */
export function decodeGrantPayload(bytes: Uint8Array): Grant {
  if (!bytes?.length) throw new Error("Grant payload is empty");
  const raw = decodeCbor(bytes) as unknown;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw))
    throw new Error("Grant payload must be a CBOR map");
  const m = raw as Map<number, unknown> | Record<number, unknown>;
  assertNoObsoleteWireKeys(m);
  return mapToGrant(m);
}

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
  const grant = leftPad(
    requireBstr(get(CBOR_KEY_GRANT_FLAGS)),
    WIRE_GRANT_FLAGS_BYTES,
  );
  const maxHeight = requireUint(get(CBOR_KEY_MAX_HEIGHT));
  const minGrowth = requireUint(get(CBOR_KEY_MIN_GROWTH));
  const grantDataRaw = get(CBOR_KEY_GRANT_DATA);
  const grantData =
    grantDataRaw instanceof Uint8Array ? grantDataRaw : new Uint8Array(0);

  return {
    logId,
    ownerLogId,
    grant,
    maxHeight,
    minGrowth,
    grantData,
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
