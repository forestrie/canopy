/**
 * Canonical decimal-string codec for uint64 values in JSON: the delegation
 * MMR range bounds on the delegation-coordinator's routes and in the webhook
 * events its receivers (mandate, thinker, forestrie-cli, the e2e kit) parse.
 */

import { describe, expect, it } from "vitest";
import {
  DecimalUint64Error,
  formatDecimalUint64,
  parseDecimalUint64,
} from "../src/index.js";

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

  it("names the value generically when no field name is given", () => {
    expect(() => parseDecimalUint64("07")).toThrow(/^value /);
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

  it("round-trips through parseDecimalUint64", () => {
    for (const v of [0n, (1n << 53n) + 1n, U64_MAX]) {
      expect(parseDecimalUint64(formatDecimalUint64(v))).toBe(v);
    }
  });

  it("refuses values outside uint64", () => {
    expect(() => formatDecimalUint64(-1n)).toThrow(DecimalUint64Error);
    expect(() => formatDecimalUint64(1n << 64n)).toThrow(DecimalUint64Error);
  });
});
