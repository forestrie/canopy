/**
 * Canonical decimal-string codec for uint64 values carried in JSON.
 *
 * JSON numbers lose precision above 2^53 in every JS consumer, so each
 * delegation MMR range bound (`mmrStart`, `mmrEnd`, payload labels 3/4)
 * travels in JSON as a decimal string matching `^(0|[1-9][0-9]*)$` with
 * value ≤ 2^64-1: on the delegation-coordinator's routes and in its
 * `delegation.required` webhook event. arbor's sealer resync parses
 * `GET /api/delegations/active` against exactly this contract
 * ([resync.go](https://github.com/forestrie/arbor/blob/main/services/sealer/src/resync.go)).
 * This module is the one TypeScript implementation: the coordinator, the e2e
 * kit, mandate, thinker and forestrie-cli import it rather than keep copies.
 * A JSON number, a leading zero, a sign or whitespace is malformed.
 */

import { UINT64_MAX } from "./to-uint64.js";

/** Canonical unsigned decimal: no sign, no leading zero, no whitespace. */
const CANONICAL_DECIMAL = /^(0|[1-9][0-9]*)$/;

/** Longest canonical decimal of a uint64 (2^64-1 has 20 digits). */
const MAX_UINT64_DIGITS = 20;

/** Thrown when a value is not a canonical decimal uint64 string. */
export class DecimalUint64Error extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DecimalUint64Error";
  }
}

/**
 * Parse a decoded JSON value as a canonical decimal uint64 string.
 *
 * @param value - The decoded JSON value; only a string is accepted.
 * @param what - Field name for error messages (e.g. "mmrStart").
 * @returns The value as `bigint` in `[0, 2^64-1]`.
 * @throws {@link DecimalUint64Error} for a non-string (including a JSON
 *   number), a non-canonical string, or a value above 2^64-1.
 */
export function parseDecimalUint64(value: unknown, what = "value"): bigint {
  if (typeof value !== "string") {
    throw new DecimalUint64Error(
      `${what} must be a decimal string (got ${value === null ? "null" : typeof value})`,
    );
  }
  if (value.length > MAX_UINT64_DIGITS || !CANONICAL_DECIMAL.test(value)) {
    throw new DecimalUint64Error(
      `${what} must be a canonical decimal uint64 string`,
    );
  }
  const parsed = BigInt(value);
  if (parsed > UINT64_MAX) {
    throw new DecimalUint64Error(`${what} exceeds 2^64-1`);
  }
  return parsed;
}

/**
 * Format a uint64 as its canonical decimal string for a JSON body.
 *
 * @param value - A `bigint` in `[0, 2^64-1]`.
 * @returns The base-10 string, byte-identical to `String(n)` for a safe
 *   integer `n`, so keys and payloads built from numbers still match.
 * @throws {@link DecimalUint64Error} when `value` is outside the uint64 range.
 */
export function formatDecimalUint64(value: bigint): string {
  if (value < 0n || value > UINT64_MAX) {
    throw new DecimalUint64Error(`value ${value} is not a uint64`);
  }
  return value.toString(10);
}
