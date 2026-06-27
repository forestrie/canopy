import { describe, expect, it } from "vitest";
import { secureHexEqual } from "../src/onboarding/secure-hex-equal.js";

describe("secureHexEqual", () => {
  it("returns true for equal hex strings", () => {
    const hex = "a".repeat(64);
    expect(secureHexEqual(hex, hex)).toBe(true);
  });

  it("returns false for different hex strings of equal length", () => {
    expect(secureHexEqual("aa", "ab")).toBe(false);
  });

  it("returns false when lengths differ", () => {
    expect(secureHexEqual("aa", "aaa")).toBe(false);
  });
});
