/**
 * Delegation MMR range bounds on the coordinator's JSON routes (canopy
 * plan-2611-01 D1, FOR-613): each `mmrStart` / `mmrEnd` is a canonical
 * decimal uint64 string, `^(0|[1-9][0-9]*)$` and ≤ 2^64-1. The coordinator
 * rejects a JSON number with 400, so the kit sends strings and reads strings
 * back, carrying `bigint` in between. Mirrors the coordinator's own
 * `decimal-uint64.ts`.
 */

import { UINT64_MAX } from "@forestrie/delegation-cose";

const CANONICAL_DECIMAL = /^(0|[1-9][0-9]*)$/;

/**
 * Parse a coordinator JSON range bound.
 *
 * @param value - The decoded JSON value; must be a canonical decimal string.
 * @param what - Field name for error messages.
 * @returns The bound as `bigint`.
 * @throws When the value is not a canonical decimal uint64 string.
 */
export function parseDecimalUint64(value: unknown, what: string): bigint {
  if (
    typeof value !== "string" ||
    value.length > 20 ||
    !CANONICAL_DECIMAL.test(value)
  ) {
    throw new Error(`${what} is not a canonical decimal uint64 string`);
  }
  const parsed = BigInt(value);
  if (parsed > UINT64_MAX) throw new Error(`${what} exceeds 2^64-1`);
  return parsed;
}

/**
 * Format a range bound for a coordinator JSON body.
 *
 * @param value - A `bigint` in `[0, 2^64-1]`.
 * @returns Its canonical decimal string.
 */
export function formatDecimalUint64(value: bigint): string {
  if (value < 0n || value > UINT64_MAX) {
    throw new Error(`value ${value} is not a uint64`);
  }
  return value.toString(10);
}
