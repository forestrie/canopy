import { decode as decodeCbor, encode as encodeCbor } from "cbor-x";
import type { Grant } from "@forestrie/encoding";
import { grantDataToBytes } from "@forestrie/encoding";
import { fromPaddedWire32, toPaddedWire32 } from "./uuid-bytes.js";

const CBOR_KEY_IDTIMESTAMP = 0;
const CBOR_KEY_LOG_ID = 1;
const CBOR_KEY_OWNER_LOG_ID = 2;
const CBOR_KEY_GRANT_FLAGS = 3;
const CBOR_KEY_MAX_HEIGHT = 4;
const CBOR_KEY_MIN_GROWTH = 5;
const CBOR_KEY_GRANT_DATA = 6;
const WIRE_GRANT_FLAGS_BYTES = 8;
const IDTIMESTAMP_BYTES = 8;

function leftPad(b: Uint8Array, length: number): Uint8Array {
  if (b.length >= length) {
    return b.length === length ? b : b.slice(-length);
  }
  const out = new Uint8Array(length);
  out.set(b, length - b.length);
  return out;
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

  return {
    logId: fromPaddedWire32(requireBstr(get(CBOR_KEY_LOG_ID))),
    ownerLogId: fromPaddedWire32(requireBstr(get(CBOR_KEY_OWNER_LOG_ID))),
    grant: leftPad(
      requireBstr(get(CBOR_KEY_GRANT_FLAGS)),
      WIRE_GRANT_FLAGS_BYTES,
    ),
    maxHeight: requireUint(get(CBOR_KEY_MAX_HEIGHT)),
    minGrowth: requireUint(get(CBOR_KEY_MIN_GROWTH)),
    grantData:
      get(CBOR_KEY_GRANT_DATA) instanceof Uint8Array
        ? (get(CBOR_KEY_GRANT_DATA) as Uint8Array)
        : new Uint8Array(0),
  };
}

export function decodeGrantPayload(bytes: Uint8Array): Grant {
  if (!bytes?.length) throw new Error("Grant payload is empty");
  const raw = decodeCbor(bytes) as unknown;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error("Grant payload must be a CBOR map");
  }
  return mapToGrant(raw as Map<number, unknown> | Record<number, unknown>);
}

export function decodeGrantResponse(bytes: Uint8Array): {
  grant: Grant;
  idtimestamp: Uint8Array;
} {
  const raw = decodeCbor(bytes) as unknown;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error("Grant response must be a CBOR map");
  }
  const m = raw as Map<number, unknown> | Record<number, unknown>;
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
  return { grant: mapToGrant(m), idtimestamp };
}

export function encodeGrantPayload(grant: Grant): Uint8Array {
  const map = new Map<number, unknown>([
    [CBOR_KEY_LOG_ID, toPaddedWire32(grant.logId)],
    [CBOR_KEY_OWNER_LOG_ID, toPaddedWire32(grant.ownerLogId)],
    [CBOR_KEY_GRANT_FLAGS, leftPad(grant.grant, WIRE_GRANT_FLAGS_BYTES)],
    [CBOR_KEY_MAX_HEIGHT, grant.maxHeight ?? 0],
    [CBOR_KEY_MIN_GROWTH, grant.minGrowth ?? 0],
    [
      CBOR_KEY_GRANT_DATA,
      grantDataToBytes(grant.grantData ?? new Uint8Array(0)),
    ],
  ]);
  return new Uint8Array(encodeCbor(map));
}
