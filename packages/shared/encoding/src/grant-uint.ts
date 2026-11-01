/**
 * The grant v0 uint fields, `maxHeight` and `minGrowth` (map keys 4 and 5),
 * are `uint64` in go-univocity and the univocity contract but `number` in
 * {@link Grant}. These two checks are the whole conversion contract, shared
 * by the encoding codec and `@forestrie/receipt-verify`'s verifier so that
 * canopy admission and offline verification accept the same grants.
 *
 * An integer `number` denotes exactly one value, so any non-negative integer
 * below 2^64 encodes exactly. Decoding is the lossy direction: a uint that a
 * `number` cannot hold exactly (2^53+1, 2^64-1) would round, and the grant
 * commitment would then hash a different value from arbor's.
 */

import { UINT64_MAX } from "./uint64.js";

/**
 * Validate a grant uint field for encoding.
 *
 * @param value - The field's `number` value (`undefined` is the caller's to
 *   default).
 * @param field - Field name for the error message.
 * @returns The value as a `bigint`, for `encodeCborDeterministic`.
 * @throws When the value is negative, fractional, NaN, infinite or at least
 *   2^64.
 */
export function grantUintToCbor(value: number, field: string): bigint {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < 0 ||
    BigInt(value) > UINT64_MAX
  ) {
    throw new Error(`Grant ${field} must be a uint64, got ${value}`);
  }
  return BigInt(value);
}

/**
 * Convert a decoded grant uint field to the `number` {@link Grant} carries.
 *
 * @param value - What `decodeCborDeterministic` returned for the field: a
 *   `number` for a safe integer, a `bigint` above that.
 * @param field - Field name for the error message.
 * @throws When the value is not a non-negative integer (CBOR major type 1
 *   decodes as a negative number), or is a `bigint` a `number` cannot hold
 *   exactly.
 */
export function grantUintFromCbor(value: unknown, field: string): number {
  if (typeof value === "number" && Number.isInteger(value) && value >= 0) {
    return value;
  }
  if (typeof value === "bigint" && value >= 0n && value <= UINT64_MAX) {
    const n = Number(value);
    if (BigInt(n) === value) return n;
    throw new Error(
      `Grant ${field} ${value} cannot be represented exactly as a number`,
    );
  }
  throw new Error(`Grant ${field} must be a uint64, got ${String(value)}`);
}
