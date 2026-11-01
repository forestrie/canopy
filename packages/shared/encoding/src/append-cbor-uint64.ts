/**
 * The package's one streaming writer for a CBOR unsigned integer (major
 * type 0), for byte-by-byte emitters that cannot go through
 * {@link ./encode-cbor-deterministic.ts} — the COSE protected header in
 * {@link ./encode-cose-protected.ts}. Everything else builds a `Map` and
 * calls `encodeCborDeterministic`, which shares this shortest-form rule.
 *
 * It replaced an exported `appendCborUint` with no 8-byte branch, which
 * truncated any value at or above 2^32 to its low 4 bytes (FOR-619 S5).
 */

import { UINT64_MAX } from "./uint64.js";

/**
 * Append a CBOR unsigned integer in the full uint64 range, shortest-form
 * encoded per RFC 8949 §4.2.1.
 *
 * @param out - Byte accumulator to append to.
 * @param v - A non-negative integer, as a `bigint` or a `number`. An integer
 *   `number` denotes one exact value, so one above 2^53 is written exactly.
 * @throws When `v` is negative, not an integer, or exceeds 2^64-1. Nothing
 *   is appended in that case.
 */
export function appendCborUint64(out: number[], v: bigint | number): void {
  let n: bigint;
  if (typeof v === "bigint") {
    n = v;
  } else {
    if (!Number.isInteger(v)) {
      throw new Error(`CBOR uint must be an integer, got ${v}`);
    }
    n = BigInt(v);
  }
  if (n < 0n) {
    throw new Error(`CBOR uint must not be negative: ${n}`);
  }
  if (n > UINT64_MAX) {
    throw new Error(`CBOR uint exceeds uint64 range: ${n}`);
  }
  if (n < 24n) {
    out.push(Number(n));
  } else if (n <= 0xffn) {
    out.push(0x18, Number(n));
  } else if (n <= 0xffffn) {
    out.push(0x19, Number((n >> 8n) & 0xffn), Number(n & 0xffn));
  } else if (n <= 0xffffffffn) {
    out.push(
      0x1a,
      Number((n >> 24n) & 0xffn),
      Number((n >> 16n) & 0xffn),
      Number((n >> 8n) & 0xffn),
      Number(n & 0xffn),
    );
  } else {
    out.push(0x1b);
    for (let shift = 56n; shift >= 0n; shift -= 8n) {
      out.push(Number((n >> shift) & 0xffn));
    }
  }
}
