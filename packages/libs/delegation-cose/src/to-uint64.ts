/**
 * uint64 validation for decoded CBOR values. `@forestrie/encoding`'s
 * `decodeCborDeterministic` returns a major-type-0 integer as `number` when
 * safe and `bigint` above 2^53, and a float as `CborFloat`; only the first
 * two are a uint64. Matches arbor
 * [delegationcert](https://github.com/forestrie/arbor/tree/main/services/pkgs/delegationcert),
 * which decodes the delegation MMR range as Go `uint64`.
 */

/** Largest value a CBOR major-type-0 integer, and a Go `uint64`, can carry. */
export const UINT64_MAX = (1n << 64n) - 1n;

/**
 * Validate a decoded CBOR value as a uint64.
 *
 * @param value - A decoded value: a `number` must be a non-negative safe
 *   integer, a `bigint` must lie in `[0, 2^64-1]`; anything else (a
 *   `CborFloat`, a string, null, …) is rejected.
 * @param what - Description for error messages.
 * @returns The value as `bigint`.
 * @throws When `value` is not a uint64.
 */
export function toUint64(value: unknown, what: string): bigint {
  if (typeof value === "number") {
    if (Number.isSafeInteger(value) && value >= 0) return BigInt(value);
    throw new Error(`${what} is not a uint64: ${value}`);
  }
  if (typeof value === "bigint") {
    if (value >= 0n && value <= UINT64_MAX) return value;
    throw new Error(`${what} is not a uint64: ${value}`);
  }
  throw new Error(`${what} is not a uint64 (got ${describeKind(value)})`);
}

function describeKind(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "object") return value.constructor?.name ?? "object";
  return typeof value;
}
