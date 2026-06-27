/**
 * Normalize COSE Sign1 unprotected headers after cbor-x decode.
 * Custodian and merge helpers expect `Map<number, unknown>`; cbor-x may yield
 * plain objects with numeric string keys.
 */

/**
 * Convert a decoded unprotected header to a numeric-key Map.
 *
 * @param value - Decoded COSE Sign1 `[1]` (Map, plain object, or unknown)
 * @returns Map with finite numeric keys; empty map when input is not mappable
 */
export function coseUnprotectedToMap(value: unknown): Map<number, unknown> {
  if (value instanceof Map) {
    const out = new Map<number, unknown>();
    for (const [k, v] of value) {
      const n = typeof k === "number" ? k : Number(k);
      if (Number.isFinite(n)) out.set(n, v);
    }
    return out;
  }
  if (
    typeof value === "object" &&
    value !== null &&
    !(value instanceof Uint8Array)
  ) {
    const out = new Map<number, unknown>();
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const n = Number(k);
      if (Number.isFinite(n)) out.set(n, v);
    }
    return out;
  }
  return new Map();
}
