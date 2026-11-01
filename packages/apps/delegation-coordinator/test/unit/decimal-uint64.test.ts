/**
 * Wire and storage codecs for the delegation MMR range: canonical decimal
 * strings on JSON routes (the string codec itself is tested in
 * `@forestrie/delegation-cose`), 8-byte big-endian BLOBs in the DO.
 */

import { describe, expect, it } from "vitest";
import { DecimalUint64Error } from "../../src/decimal-uint64.js";
import {
  decodeMmrIndexBe8,
  encodeMmrIndexBe8,
} from "../../src/mmr-index-be8.js";
import { parseJsonMmrRange } from "../../src/mmr-range.js";

const U64_MAX = (1n << 64n) - 1n;

describe("parseJsonMmrRange", () => {
  it("parses both bounds", () => {
    expect(parseJsonMmrRange({ mmrStart: "5", mmrEnd: "5" })).toEqual({
      mmrStart: 5n,
      mmrEnd: 5n,
    });
  });

  it("rejects start above end", () => {
    expect(() => parseJsonMmrRange({ mmrStart: "6", mmrEnd: "5" })).toThrow(
      DecimalUint64Error,
    );
  });

  it("rejects a missing bound", () => {
    expect(() => parseJsonMmrRange({ mmrStart: "0" })).toThrow(/mmrEnd/);
  });
});

describe("mmr index be8 codec", () => {
  it.each([0n, 255n, 1n << 32n, (1n << 53n) + 1n, 1n << 63n, U64_MAX])(
    "round-trips %s",
    (value) => {
      const bytes = encodeMmrIndexBe8(value);
      expect(bytes.length).toBe(8);
      expect(decodeMmrIndexBe8(bytes)).toBe(value);
      expect(decodeMmrIndexBe8(bytes.slice().buffer)).toBe(value);
    },
  );

  it("is big-endian", () => {
    expect([...encodeMmrIndexBe8(0x0102030405060708n)]).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8,
    ]);
  });

  it("rejects out-of-range values and non-be8 column values", () => {
    expect(() => encodeMmrIndexBe8(-1n)).toThrow();
    expect(() => encodeMmrIndexBe8(1n << 64n)).toThrow();
    expect(() => decodeMmrIndexBe8(7)).toThrow();
    expect(() => decodeMmrIndexBe8(new Uint8Array(7))).toThrow();
    expect(() => decodeMmrIndexBe8(null)).toThrow();
  });
});
