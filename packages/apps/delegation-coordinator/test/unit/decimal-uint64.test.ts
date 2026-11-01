/**
 * JSON wire parsing of the delegation MMR range: canonical decimal strings
 * (the string codec itself is tested in `@forestrie/delegation-cose`; the
 * be8 storage codec in `@forestrie/encoding`).
 */

import { describe, expect, it } from "vitest";
import { DecimalUint64Error } from "../../src/decimal-uint64.js";
import { parseJsonMmrRange } from "../../src/mmr-range.js";

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
