/**
 * Strict non-negative integer validation for decoded CBOR values that are
 * carried as JS `number`: the delegation payload's schema version and Unix
 * seconds validity window (labels 7/8/9). A `CborFloat`, a negative, a
 * string or an integer above 2^53-1 is rejected rather than coerced, so a
 * malformed label can never read as `NaN` or a rounded value.
 */

/**
 * Validate a decoded CBOR value as a non-negative safe integer.
 *
 * @param value - A decoded value: a `number` must be a non-negative safe
 *   integer, a `bigint` must lie in `[0, 2^53-1]`; anything else (a
 *   `CborFloat`, a string, null, …) is rejected.
 * @param what - Description for error messages.
 * @returns The value as `number`.
 * @throws When `value` is not a non-negative safe integer.
 */
export function toSafeUint(value: unknown, what: string): number {
  if (typeof value === "number") {
    if (Number.isSafeInteger(value) && value >= 0) return value;
    throw new Error(`${what} is not a safe uint: ${value}`);
  }
  if (typeof value === "bigint") {
    if (value >= 0n && value <= BigInt(Number.MAX_SAFE_INTEGER)) {
      return Number(value);
    }
    throw new Error(`${what} is not a safe uint: ${value}`);
  }
  throw new Error(`${what} is not a safe uint (got ${describeKind(value)})`);
}

function describeKind(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "object") return value.constructor?.name ?? "object";
  return typeof value;
}
