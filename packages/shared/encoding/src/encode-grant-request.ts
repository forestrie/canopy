/**
 * Grant request CBOR encoder (Forestrie-Grant **v0**).
 * Emits CBOR map keys **1–6** only (grant content; no idtimestamp). Idtimestamp
 * is supplied separately by canopy-api sequencing. Wire layout:
 * [grants.md §3.1](https://github.com/forestrie/canopy/blob/main/docs/grants.md#31-inner-grant-payload-cbor).
 */

import { encodeCborDeterministic } from "./encode-cbor-deterministic.js";
import { grantDataToBytes } from "./grant-data.js";
import { grantUintToCbor } from "./grant-uint.js";

const WIRE_LOG_ID_OWNER_LOG_ID_BYTES = 32;
const WIRE_GRANT_FLAGS_BYTES = 8;

/** Left-pad, or keep the low-order bytes, to a fixed width (univocity/go-univocity wire convention). */
function leftPad(b: Uint8Array, length: number): Uint8Array {
  if (b.length >= length) {
    return b.length === length ? b : b.slice(-length);
  }
  const out = new Uint8Array(length);
  out.set(b, length - b.length);
  return out;
}

/** Wire format key labels (grant content keys 1–6 only, v0). */
export const GRANT_REQUEST_KEYS = {
  logId: 1,
  ownerLogId: 2,
  /** Solidity `PublishGrant.grant` (flags); CBOR key 3. */
  grant: 3,
  maxHeight: 4,
  minGrowth: 5,
  grantData: 6,
} as const;

/** Grant content fields for POST `/register/grants` CBOR body (keys 1–6). */
export interface GrantRequestInput {
  /** Target log id (padded to 32 bytes on wire). */
  logId: Uint8Array;
  /** Owner (authority) log id (padded to 32 bytes on wire). */
  ownerLogId: Uint8Array;
  /** 8-byte grant flags bitmap (`PublishGrant.grant` on-chain). */
  grant: Uint8Array;
  /** Optional max MMR height bound (defaults to 0). */
  maxHeight?: number;
  /** Optional minimum growth bound (defaults to 0). */
  minGrowth?: number;
  /** Opaque grantData committed in the grant preimage. */
  grantData: Uint8Array;
}

/**
 * Encode grant content as CBOR map keys 1–6. Left-pads log ids to 32 bytes and
 * grant flags to 8 bytes before encoding.
 *
 * `encodeCborDeterministic` emits the keys in ascending order. Every key here
 * is a single byte, so that order is canonical under both the length-first
 * order this package applies ({@link ./canonical-key-order.ts}) and RFC 8949
 * §4.2.1's pure bytewise one; the two differ only across unequal key lengths.
 *
 * @param input - Grant content fields (idtimestamp is not included)
 * @returns CBOR map bytes suitable for register-grant request bodies
 * @throws When `maxHeight` or `minGrowth` is negative, fractional, NaN,
 *   infinite or at least 2^64, or `grantData` is not bytes.
 */
export function encodeGrantRequest(input: GrantRequestInput): Uint8Array {
  const k = GRANT_REQUEST_KEYS;
  return encodeCborDeterministic(
    new Map<number, unknown>([
      [k.logId, leftPad(input.logId, WIRE_LOG_ID_OWNER_LOG_ID_BYTES)],
      [k.ownerLogId, leftPad(input.ownerLogId, WIRE_LOG_ID_OWNER_LOG_ID_BYTES)],
      [k.grant, leftPad(input.grant, WIRE_GRANT_FLAGS_BYTES)],
      [k.maxHeight, grantUintToCbor(input.maxHeight ?? 0, "maxHeight")],
      [k.minGrowth, grantUintToCbor(input.minGrowth ?? 0, "minGrowth")],
      // Normalised like the other grant encoders: a structured GrantData
      // that slipped past the type must not encode as a CBOR map.
      [k.grantData, grantDataToBytes(input.grantData ?? new Uint8Array(0))],
    ]),
  );
}
