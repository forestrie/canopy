/**
 * Univocity instance key derivation (FOR-468).
 */

import { describe, expect, it } from "vitest";
import {
  instanceKeyFromGenesisChainBinding,
  instanceKeyFromStoredChainBinding,
} from "../src/forest/instance-key.js";

describe("instanceKeyFromStoredChainBinding", () => {
  it("renders chainId:univocityAddr in lowercase", () => {
    expect(
      instanceKeyFromStoredChainBinding({
        chainId: "84532",
        univocityAddr: "AABBCCDDEEFF00112233445566778899AABBCCDD",
      }),
    ).toBe("84532:aabbccddeeff00112233445566778899aabbccdd");
  });

  it("tolerates a 0x-prefixed address", () => {
    expect(
      instanceKeyFromStoredChainBinding({
        chainId: "84532",
        univocityAddr: `0x${"42".repeat(20)}`,
      }),
    ).toBe(`84532:${"42".repeat(20)}`);
  });

  it("accepts a CAIP-2 style chain id", () => {
    expect(
      instanceKeyFromStoredChainBinding({
        chainId: "eip155:84532",
        univocityAddr: "42".repeat(20),
      }),
    ).toBe(`eip155:84532:${"42".repeat(20)}`);
  });

  // No instance is not an error: the log simply inherits nothing.
  it("returns undefined for an empty or unusable binding", () => {
    expect(
      instanceKeyFromStoredChainBinding({ chainId: "", univocityAddr: "abcd" }),
    ).toBeUndefined();
    expect(
      instanceKeyFromStoredChainBinding({
        chainId: "84532",
        univocityAddr: "",
      }),
    ).toBeUndefined();
    expect(
      instanceKeyFromStoredChainBinding({
        chainId: "chain id with spaces",
        univocityAddr: "abcd",
      }),
    ).toBeUndefined();
  });
});

describe("instanceKeyFromGenesisChainBinding", () => {
  it("hex-encodes the genesis address bytes", () => {
    expect(
      instanceKeyFromGenesisChainBinding({
        chainId: "84532",
        address: new Uint8Array(20).fill(0x42),
      }),
    ).toBe(`84532:${"42".repeat(20)}`);
  });
});
