import { describe, expect, it } from "vitest";
import {
  hex32ToCanonicalUuid,
  logIdWireBytesToHex32,
  normalizeLogIdToHex32,
} from "../../src/log-id.js";

describe("normalizeLogIdToHex32", () => {
  it("normalizes dashed UUID to 32 hex", () => {
    expect(normalizeLogIdToHex32("550e8400-e29b-41d4-a716-446655440000")).toBe(
      "550e8400e29b41d4a716446655440000",
    );
  });

  it("accepts undashed 32 hex", () => {
    expect(normalizeLogIdToHex32("550e8400e29b41d4a716446655440000")).toBe(
      "550e8400e29b41d4a716446655440000",
    );
  });

  it("uses right-aligned UUID from 64-char wire hex", () => {
    const wire =
      "00000000000000000000000000000000550e8400e29b41d4a716446655440000";
    expect(normalizeLogIdToHex32(wire)).toBe(
      "550e8400e29b41d4a716446655440000",
    );
  });

  it("rejects invalid segments", () => {
    expect(() => normalizeLogIdToHex32("not-a-log-id")).toThrow();
  });
});

describe("logIdWireBytesToHex32", () => {
  it("encodes 16 raw UUID bytes", () => {
    const bytes = new Uint8Array(16);
    bytes[0] = 0x55;
    bytes[1] = 0x0e;
    expect(logIdWireBytesToHex32(bytes)).toMatch(/^[0-9a-f]{32}$/);
  });
});

describe("hex32ToCanonicalUuid", () => {
  it("formats canonical UUID for shard routing", () => {
    expect(
      hex32ToCanonicalUuid("550e8400e29b41d4a716446655440000"),
    ).toBe("550e8400-e29b-41d4-a716-446655440000");
  });
});
