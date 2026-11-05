/**
 * Grant CBOR encode/decode (Forestrie-Grant **v0**): map keys **1–6** only — `logId`, `ownerLogId`,
 * `grant` (flags), `maxHeight`, `minGrowth`, `grantData`. No `signer` (7), `kind` (8), `version`,
 * `exp`, or `nbf` on the wire; idtimestamp is never in this map.
 *
 * **Response format (keys 0–6):** key 0 = idtimestamp; keys 1–6 = grant fields. Used for GET
 * response encoding only.
 */

import type { Grant } from "./grant.js";
import { encodeCborDeterministic } from "./encode-cbor-deterministic.js";
import { decodeCborDeterministic } from "./decode-cbor-deterministic.js";
import { grantDataToBytes } from "./grant-data.js";
import { fromPaddedWire32, toPaddedWire32 } from "./uuid-bytes.js";
import { grantUintFromCbor, grantUintToCbor } from "./grant-uint.js";

const CBOR_KEY_IDTIMESTAMP = 0;
const CBOR_KEY_LOG_ID = 1;
const CBOR_KEY_OWNER_LOG_ID = 2;
const CBOR_KEY_GRANT_FLAGS = 3;
const CBOR_KEY_MAX_HEIGHT = 4;
const CBOR_KEY_MIN_GROWTH = 5;
const CBOR_KEY_GRANT_DATA = 6;

const WIRE_GRANT_FLAGS_BYTES = 8;
const IDTIMESTAMP_BYTES = 8;

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
  return encodeCborDeterministic(
    new Map<number, unknown>([
      [CBOR_KEY_IDTIMESTAMP, idts],
      ...grantWireEntries(grant),
    ]),
  );
}

/** Decode CBOR response bytes (keys 0–6). */
export function decodeGrantResponse(bytes: Uint8Array): {
  grant: Grant;
  idtimestamp: Uint8Array;
} {
  if (!bytes?.length) throw new Error("Grant payload is empty");
  const raw = decodeCborDeterministic(bytes) as unknown;
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
  return encodeCborDeterministic(new Map(grantWireEntries(grant)));
}

/** Decode grant payload (CBOR map keys 1–6 only). */
export function decodeGrantPayload(bytes: Uint8Array): Grant {
  if (!bytes?.length) throw new Error("Grant payload is empty");
  const raw = decodeCborDeterministic(bytes) as unknown;
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

  const logId = fromPaddedWire32(requireBstr(get(CBOR_KEY_LOG_ID)));
  const ownerLogId = fromPaddedWire32(requireBstr(get(CBOR_KEY_OWNER_LOG_ID)));
  const grant = leftPad(
    requireBstr(get(CBOR_KEY_GRANT_FLAGS)),
    WIRE_GRANT_FLAGS_BYTES,
  );
  const maxHeight = grantUintFromCbor(get(CBOR_KEY_MAX_HEIGHT), "maxHeight");
  const minGrowth = grantUintFromCbor(get(CBOR_KEY_MIN_GROWTH), "minGrowth");
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

/**
 * Grant v0 keys 1–6 in ascending order. `encodeCborDeterministic` sorts map
 * keys anyway; every key is a single byte, so the length-first order this
 * package applies (canonical-key-order.ts) and RFC 8949 §4.2.1's bytewise
 * order agree.
 *
 * @throws When `maxHeight` or `minGrowth` is negative, fractional, NaN,
 *   infinite or at least 2^64 ({@link grantUintToCbor}). The old hand-rolled
 *   writers emitted wrong bytes for these instead.
 */
function grantWireEntries(grant: Grant): [number, unknown][] {
  return [
    [CBOR_KEY_LOG_ID, toPaddedWire32(grant.logId as Uint8Array)],
    [CBOR_KEY_OWNER_LOG_ID, toPaddedWire32(grant.ownerLogId as Uint8Array)],
    [
      CBOR_KEY_GRANT_FLAGS,
      leftPad(grant.grant as Uint8Array, WIRE_GRANT_FLAGS_BYTES),
    ],
    [CBOR_KEY_MAX_HEIGHT, grantUintToCbor(grant.maxHeight ?? 0, "maxHeight")],
    [CBOR_KEY_MIN_GROWTH, grantUintToCbor(grant.minGrowth ?? 0, "minGrowth")],
    [
      CBOR_KEY_GRANT_DATA,
      grantDataToBytes(grant.grantData ?? new Uint8Array(0)),
    ],
  ];
}
