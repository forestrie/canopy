/**
 * Normalize COSE Sign1 unprotected header (CBOR map) to Map<number, unknown>.
 * Handles Map instances and plain objects with numeric string keys (cbor-x decode shapes).
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
