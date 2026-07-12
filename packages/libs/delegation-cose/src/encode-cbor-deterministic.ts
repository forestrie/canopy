/**
 * Minimal deterministic CBOR writer (RFC 8949 §4.2 core deterministic encoding).
 *
 * Vendored copy of `@canopy/encoding`'s `encode-cbor-deterministic.ts` — this
 * published package stays self-contained rather than depending on the private
 * `@canopy/encoding` workspace lib (same pattern as `encode-sig-structure.ts`).
 * Keep the two copies in sync.
 *
 * Definite lengths only, shortest-form integer/length arguments, no tags, and
 * map keys sorted by the bytewise lexicographic order of their encoded key
 * bytes (§4.2.1). This replaces `cbor-x`'s `encode`, which tags every
 * `Uint8Array` with tag 64 and every `Map` with tag 259 — extensions that
 * strict COSE/SCITT decoders (and the Go `delegationcert` sealer) reject (see
 * status-2607-03-remove-cbor-x-for-scitt-cose-canonicity). Output is
 * byte-for-byte identical to Go `delegationcert` with
 * `cbor.SortCoreDeterministic`.
 *
 * Supported value types: unsigned + negative integers (`number` | `bigint`),
 * `boolean`, `null`, byte strings (`Uint8Array` | `ArrayBuffer`), text strings
 * (`string`), arrays, integer/text-keyed maps (`Map`), and plain objects
 * (encoded as canonical text-keyed maps with `undefined` properties skipped,
 * matching Go `map[string]any`). Non-integer numbers and any other type throw
 * rather than emitting silently-wrong bytes.
 */

/** CBOR major types (RFC 8949 §3). */
const MAJOR_UINT = 0;
const MAJOR_NINT = 1;
const MAJOR_BSTR = 2;
const MAJOR_TSTR = 3;
const MAJOR_ARRAY = 4;
const MAJOR_MAP = 5;

/** Concatenate byte arrays into one buffer. */
function concat(chunks: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

/**
 * Encode a major type + argument as a CBOR head using the shortest form
 * (RFC 8949 §4.2.1 "preferred serialization").
 */
function encodeHead(major: number, argument: number | bigint): Uint8Array {
  const mt = major << 5;
  const n = typeof argument === "bigint" ? argument : BigInt(argument);
  if (n < 0n) throw new Error("encodeHead: argument must be non-negative");
  if (n < 24n) return new Uint8Array([mt | Number(n)]);
  if (n < 0x100n) return new Uint8Array([mt | 24, Number(n)]);
  if (n < 0x10000n) {
    return new Uint8Array([mt | 25, Number(n >> 8n) & 0xff, Number(n) & 0xff]);
  }
  if (n < 0x100000000n) {
    return new Uint8Array([
      mt | 26,
      Number((n >> 24n) & 0xffn),
      Number((n >> 16n) & 0xffn),
      Number((n >> 8n) & 0xffn),
      Number(n & 0xffn),
    ]);
  }
  if (n < 0x10000000000000000n) {
    const out = new Uint8Array(9);
    out[0] = mt | 27;
    let v = n;
    for (let i = 8; i >= 1; i--) {
      out[i] = Number(v & 0xffn);
      v >>= 8n;
    }
    return out;
  }
  throw new Error("encodeHead: argument exceeds 64-bit range");
}

/** Encode a JS integer (number or bigint) as CBOR major type 0 or 1. */
function encodeInteger(v: number | bigint): Uint8Array {
  if (typeof v === "number" && !Number.isInteger(v)) {
    throw new Error(`encodeCborDeterministic: non-integer number ${v}`);
  }
  const n = typeof v === "bigint" ? v : BigInt(v);
  if (n >= 0n) return encodeHead(MAJOR_UINT, n);
  return encodeHead(MAJOR_NINT, -1n - n);
}

/**
 * Serialize a value as canonical (RFC 8949 §4.2) CBOR.
 *
 * @param value - Integer, boolean, null, byte string, text string, array, Map,
 *   or plain object (see module doc for the full supported set)
 * @returns Deterministic CBOR bytes (definite lengths, sorted map keys, no tags)
 * @throws On non-integer numbers, `undefined`, functions, symbols, or non-string
 *   map keys
 */
export function encodeCborDeterministic(value: unknown): Uint8Array {
  if (typeof value === "number" || typeof value === "bigint") {
    return encodeInteger(value);
  }
  if (typeof value === "boolean") {
    return new Uint8Array([value ? 0xf5 : 0xf4]); // major 7: true / false
  }
  if (value === null) {
    return new Uint8Array([0xf6]); // major 7: null
  }
  if (value instanceof Uint8Array) {
    return concat([encodeHead(MAJOR_BSTR, value.length), value]);
  }
  if (value instanceof ArrayBuffer) {
    const bytes = new Uint8Array(value);
    return concat([encodeHead(MAJOR_BSTR, bytes.length), bytes]);
  }
  if (typeof value === "string") {
    const bytes = new TextEncoder().encode(value);
    return concat([encodeHead(MAJOR_TSTR, bytes.length), bytes]);
  }
  if (Array.isArray(value)) {
    const items = value.map((v) => encodeCborDeterministic(v));
    return concat([encodeHead(MAJOR_ARRAY, value.length), ...items]);
  }
  if (value instanceof Map) {
    return encodeMap(value as Map<unknown, unknown>);
  }
  if (typeof value === "object") {
    // Plain object → canonical text-keyed map (Go `map[string]any` / cbor-x).
    // Skip undefined-valued properties (JSON/CBOR-map semantics: absent, not nil).
    const entries = Object.entries(value as Record<string, unknown>).filter(
      ([, v]) => v !== undefined,
    );
    return encodeMap(new Map(entries));
  }
  throw new Error(
    `encodeCborDeterministic: unsupported value type ${typeof value}`,
  );
}

/**
 * Encode a Map with keys sorted by the bytewise lexicographic order of their
 * encoded key bytes (RFC 8949 §4.2.1 core deterministic map ordering).
 */
function encodeMap(map: Map<unknown, unknown>): Uint8Array {
  const entries = Array.from(map.entries()).map(([k, v]) => {
    if (
      typeof k !== "number" &&
      typeof k !== "bigint" &&
      typeof k !== "string"
    ) {
      throw new Error(
        `encodeCborDeterministic: unsupported map key type ${typeof k}`,
      );
    }
    return {
      keyBytes: encodeCborDeterministic(k),
      valueBytes: encodeCborDeterministic(v),
    };
  });
  entries.sort((a, b) => compareBytes(a.keyBytes, b.keyBytes));
  const chunks: Uint8Array[] = [encodeHead(MAJOR_MAP, entries.length)];
  for (const e of entries) {
    chunks.push(e.keyBytes, e.valueBytes);
  }
  return concat(chunks);
}

/** Bytewise lexicographic comparison (shorter-and-equal-prefix sorts first). */
function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a[i] !== b[i]) return a[i]! - b[i]!;
  }
  return a.length - b.length;
}
