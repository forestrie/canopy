import { describe, expect, it } from "vitest";
import { grantUintFromCbor, grantUintToCbor } from "./index.js";

describe("grantUintFromCbor", () => {
  // decodeCborDeterministic yields a number only for a safe integer; an
  // unsafe number came from elsewhere (cbor-x, JSON) and may already have
  // rounded, so it is not trusted as exact.
  it.each([2 ** 53, 2 ** 60])("rejects the unsafe number %s", (v) => {
    expect(() => grantUintFromCbor(v, "maxHeight")).toThrow(/maxHeight/);
  });

  it("accepts the same value as a bigint", () => {
    expect(grantUintFromCbor(1n << 60n, "maxHeight")).toBe(2 ** 60);
  });

  it("round-trips the largest number below 2^64 through grantUintToCbor", () => {
    const v = 2 ** 64 - 2048;
    expect(
      grantUintFromCbor(grantUintToCbor(v, "maxHeight"), "maxHeight"),
    ).toBe(v);
  });
});
