/**
 * Minimal canonicalization helpers for deterministic CBOR encoding.
 *
 * We rely on `cbor-x` preserving Map insertion order when encoding maps.
 * To satisfy RFC8949 deterministic ordering for map keys, we normalize
 * objects/maps into Maps with keys inserted in canonical order.
 */

const textEncoder = new TextEncoder();

function utf8Bytes(s: string): Uint8Array {
  return textEncoder.encode(s);
}

function compareBytesLex(a: Uint8Array, b: Uint8Array): number {
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const d = a[i] - b[i];
    if (d !== 0) return d;
  }
  return a.length - b.length;
}

/**
 * RFC8949 deterministic ordering for tstr keys:
 * sort by byte length, then lexicographically by UTF-8 bytes.
 */
function compareTextKeys(a: string, b: string): number {
  const ab = utf8Bytes(a);
  const bb = utf8Bytes(b);
  if (ab.length !== bb.length) return ab.length - bb.length;
  return compareBytesLex(ab, bb);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as any).constructor === Object
  );
}

/**
 * Canonicalize a value tree into a form that encodes deterministically with `cbor-x`.
 *
 * - Plain objects become Maps with canonical key ordering.
 * - Maps become Maps with canonical key ordering (string keys only).
 * - Arrays are recursively canonicalized.
 * - Uint8Array is left as-is.
 */
export function canonicalizeCbor(value: unknown): unknown {
  if (value instanceof Uint8Array) return value;
  if (Array.isArray(value)) return value.map(canonicalizeCbor);

  if (value instanceof Map) {
    const entries: Array<[string, unknown]> = [];
    for (const [k, v] of value.entries()) {
      if (typeof k !== "string") {
        throw new Error("constraints map keys must be text strings");
      }
      entries.push([k, v]);
    }

    entries.sort((a, b) => compareTextKeys(a[0], b[0]));
    return new Map(entries.map(([k, v]) => [k, canonicalizeCbor(v)]));
  }

  if (isPlainObject(value)) {
    const keys = Object.keys(value).sort(compareTextKeys);
    const out = new Map<string, unknown>();
    for (const k of keys) {
      out.set(k, canonicalizeCbor(value[k]));
    }
    return out;
  }

  return value;
}


