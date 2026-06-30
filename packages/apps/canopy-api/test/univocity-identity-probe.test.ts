import { describe, expect, it } from "vitest";
import {
  COSE_ALG_ES256,
  decodeBootstrapConfigResult,
  decodeRootLogIdResult,
  validBootstrapIdentity,
} from "../src/onboarding/univocity-identity-probe.js";

describe("univocity identity probe decode", () => {
  it("accepts ES256 bootstrap with 64-byte key", () => {
    const alg =
      "fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff9";
    const offset =
      "0000000000000000000000000000000000000000000000000000000000000040";
    const len =
      "0000000000000000000000000000000000000000000000000000000000000040";
    const key = "ab".repeat(64);
    const hex = `0x${alg}${offset}${len}${key}`;
    const decoded = decodeBootstrapConfigResult(hex);
    expect(decoded).not.toBeNull();
    expect(decoded!.alg).toBe(COSE_ALG_ES256);
    expect(decoded!.key.length).toBe(64);
    expect(validBootstrapIdentity(decoded!.alg, decoded!.key)).toBe(true);
  });

  it("decodes rootLogId as 32 bytes including zero pre-genesis", () => {
    const root = decodeRootLogIdResult(`0x${"00".repeat(32)}`);
    expect(root).not.toBeNull();
    expect(root!.length).toBe(32);
    expect(root!.every((b) => b === 0)).toBe(true);
  });

  it("accepts arbitrary rootLogId bytes (no path logId comparison at probe)", () => {
    const pathLogId = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";
    const onChainRootHex =
      "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef";
    const decoded = decodeRootLogIdResult(onChainRootHex);
    expect(decoded).not.toBeNull();
    const pathAsHex = pathLogId.replace(/-/g, "");
    expect(Buffer.from(decoded!).toString("hex")).not.toBe(pathAsHex);
  });
});
