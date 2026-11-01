/**
 * Storage codec for delegation MMR range bounds in the coordinator's Durable
 * Object SQLite: uint64 bounds as 8-byte big-endian BLOBs, so byte order is
 * numeric order.
 *
 * SQLite `INTEGER` is signed int64, so a uint64 above 2^63-1 cannot be stored
 * as one. Each bound is stored as an 8-byte big-endian BLOB instead. SQLite
 * compares BLOBs with `memcmp`, and for equal-length big-endian unsigned
 * values that is numeric order — so `<=` / `>=` coverage queries, `MIN` /
 * `MAX` aggregation and `ORDER BY` keep working unchanged, provided EVERY
 * bound value (column and bound parameter alike) goes through this codec. An
 * INTEGER compared with a BLOB is always less in SQLite, so a stray number
 * parameter silently mis-compares.
 */

import { UINT64_MAX } from "@forestrie/delegation-cose";

/** Width of a stored bound: one uint64. */
const BE8_LENGTH = 8;

/**
 * Encode a uint64 as the 8-byte big-endian BLOB the range columns hold.
 *
 * @param value - A `bigint` in `[0, 2^64-1]`.
 * @returns 8 bytes, most significant first.
 * @throws When `value` is outside the uint64 range.
 */
export function encodeMmrIndexBe8(value: bigint): Uint8Array {
  if (value < 0n || value > UINT64_MAX) {
    throw new Error(`MMR index ${value} is not a uint64`);
  }
  const out = new Uint8Array(BE8_LENGTH);
  new DataView(out.buffer).setBigUint64(0, value, false);
  return out;
}

/**
 * Decode a range column value read back from SQLite.
 *
 * @param value - The column value: an `ArrayBuffer` (how the DO SQL API
 *   returns a BLOB) or `Uint8Array` of exactly 8 bytes.
 * @returns The uint64 as `bigint`.
 * @throws When the value is not an 8-byte BLOB (e.g. an unmigrated INTEGER).
 */
export function decodeMmrIndexBe8(value: unknown): bigint {
  const bytes =
    value instanceof ArrayBuffer
      ? new Uint8Array(value)
      : value instanceof Uint8Array
        ? value
        : null;
  if (!bytes || bytes.length !== BE8_LENGTH) {
    throw new Error("MMR index column is not an 8-byte big-endian BLOB");
  }
  return new DataView(
    bytes.buffer,
    bytes.byteOffset,
    bytes.byteLength,
  ).getBigUint64(0, false);
}
