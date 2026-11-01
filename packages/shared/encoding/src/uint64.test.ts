/**
 * uint64 primitives shared by every package that carries an MMR or leaf
 * index: strict validation of a decoded CBOR value, and the 8-byte
 * big-endian BLOB form Durable Object SQLite stores so that byte order is
 * numeric order.
 */

import { describe, expect, it } from "vitest";
import { encodeCborDeterministic } from "./encode-cbor-deterministic.js";
import { decodeCborDeterministic } from "./decode-cbor-deterministic.js";
import {
  UINT64_MAX,
  decodeUint64Be8,
  encodeUint64Be8,
  toUint64,
} from "./index.js";

const EDGES = [0n, 255n, 1n << 32n, (1n << 53n) + 1n, 1n << 63n, UINT64_MAX];

describe("toUint64", () => {
  it.each(EDGES)("accepts %s decoded from CBOR major type 0", (value) => {
    const decoded = decodeCborDeterministic(encodeCborDeterministic(value));
    expect(toUint64(decoded, "index")).toBe(value);
  });

  it("rejects negatives, unsafe numbers, values above 2^64-1 and non-integers", () => {
    expect(() => toUint64(-1, "index")).toThrow(/index is not a uint64/);
    expect(() => toUint64(-1n, "index")).toThrow(/not a uint64/);
    expect(() => toUint64(2 ** 53, "index")).toThrow(/not a uint64/);
    expect(() => toUint64(1.5, "index")).toThrow(/not a uint64/);
    expect(() => toUint64(UINT64_MAX + 1n, "index")).toThrow(/not a uint64/);
    expect(() => toUint64("1", "index")).toThrow(/got string/);
    expect(() => toUint64(null, "index")).toThrow(/got null/);
  });
});

describe("uint64 be8 codec", () => {
  it.each(EDGES)("round-trips %s through Uint8Array and ArrayBuffer", (v) => {
    const bytes = encodeUint64Be8(v);
    expect(bytes.length).toBe(8);
    expect(decodeUint64Be8(bytes)).toBe(v);
    expect(decodeUint64Be8(bytes.slice().buffer)).toBe(v);
  });

  it("is big-endian", () => {
    expect([...encodeUint64Be8(0x0102030405060708n)]).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8,
    ]);
  });

  it("orders bytewise as the values order numerically", () => {
    const blobs = EDGES.map(encodeUint64Be8);
    for (let i = 1; i < blobs.length; i++) {
      expect(Buffer.compare(blobs[i - 1], blobs[i])).toBe(-1);
    }
  });

  it("rejects out-of-range values and anything that is not 8 bytes", () => {
    expect(() => encodeUint64Be8(-1n)).toThrow();
    expect(() => encodeUint64Be8(UINT64_MAX + 1n)).toThrow();
    expect(() => decodeUint64Be8(7)).toThrow();
    expect(() => decodeUint64Be8(7n)).toThrow();
    expect(() => decodeUint64Be8(new Uint8Array(7))).toThrow();
    expect(() => decodeUint64Be8(null)).toThrow();
  });
});
