/**
 * Wire and storage codecs for the delegation MMR range (plan-2611-01 D1/D2,
 * FOR-613): canonical decimal strings on JSON routes, 8-byte big-endian
 * BLOBs in the DO.
 */

import { describe, expect, it } from "vitest";
import {
  DecimalUint64Error,
  formatDecimalUint64,
  parseDecimalUint64,
} from "../../src/decimal-uint64.js";
import {
  decodeMmrIndexBe8,
  encodeMmrIndexBe8,
} from "../../src/mmr-index-be8.js";
import { parseJsonMmrRange } from "../../src/mmr-range.js";

const U64_MAX = (1n << 64n) - 1n;

describe("parseDecimalUint64", () => {
  it.each([
    ["0", 0n],
    ["1", 1n],
    ["4294967297", (1n << 32n) + 1n],
    ["9007199254740993", (1n << 53n) + 1n],
    ["18446744073709551615", U64_MAX],
  ])("parses %s", (text, value) => {
    expect(parseDecimalUint64(text, "mmrEnd")).toBe(value);
  });

  it.each([
    ["a JSON number", 7],
    ["a bigint", 7n],
    ["null", null],
    ["undefined", undefined],
    ["empty", ""],
    ["leading zero", "07"],
    ["double zero", "00"],
    ["plus sign", "+7"],
    ["minus sign", "-7"],
    ["minus zero", "-0"],
    ["whitespace", " 7"],
    ["trailing newline", "7\n"],
    ["fraction", "7.0"],
    ["exponent", "7e0"],
    ["hex", "0x7"],
    ["2^64", "18446744073709551616"],
    ["21 digits", "100000000000000000000"],
  ])("rejects %s", (_label, value) => {
    expect(() => parseDecimalUint64(value, "mmrEnd")).toThrow(
      DecimalUint64Error,
    );
    expect(() => parseDecimalUint64(value, "mmrEnd")).toThrow(/mmrEnd/);
  });
});

describe("formatDecimalUint64", () => {
  it("is String(n) for a safe integer and exact above 2^53", () => {
    expect(formatDecimalUint64(16383n)).toBe(String(16383));
    expect(formatDecimalUint64(BigInt(Number.MAX_SAFE_INTEGER))).toBe(
      String(Number.MAX_SAFE_INTEGER),
    );
    expect(formatDecimalUint64(U64_MAX)).toBe("18446744073709551615");
  });

  it("refuses values outside uint64", () => {
    expect(() => formatDecimalUint64(-1n)).toThrow(DecimalUint64Error);
    expect(() => formatDecimalUint64(1n << 64n)).toThrow(DecimalUint64Error);
  });
});

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
