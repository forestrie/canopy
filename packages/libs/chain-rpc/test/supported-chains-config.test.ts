/**
 * `SUPPORTED_CHAINS_RPC` parsing, env resolution, and chain id lookups.
 */

import { describe, expect, it } from "vitest";

import {
  isChainIdSupported,
  parseSupportedChainsRpc,
  rpcUrlsForChainId,
  supportedChainIds,
} from "../src/supported-chains-config.js";

describe("parseSupportedChainsRpc", () => {
  const template = JSON.stringify({
    "84532": [
      "https://base-sepolia.g.alchemy.com/v2/${env:ALCHEMY_API_KEY}",
      "https://sepolia.base.org",
    ],
  });

  it("parses chain id to url arrays without env resolution", () => {
    const config = parseSupportedChainsRpc(template);
    expect(config["84532"]).toHaveLength(2);
    expect(config["84532"]![0]).toContain("${env:ALCHEMY_API_KEY}");
  });

  it("resolves env templates when resolveEnv is true", () => {
    const config = parseSupportedChainsRpc(template, {
      resolveEnv: true,
      env: { ALCHEMY_API_KEY: "abc123" },
    });
    expect(config["84532"]![0]).toBe(
      "https://base-sepolia.g.alchemy.com/v2/abc123",
    );
    expect(config["84532"]![1]).toBe("https://sepolia.base.org");
  });

  it("rejects invalid chain id keys", () => {
    expect(() =>
      parseSupportedChainsRpc(JSON.stringify({ "0x1": ["https://x"] })),
    ).toThrow(/chain id/i);
  });

  it("rejects empty url lists", () => {
    expect(() => parseSupportedChainsRpc(JSON.stringify({ "1": [] }))).toThrow(
      /url/i,
    );
  });
});

describe("rpcUrlsForChainId", () => {
  const config = parseSupportedChainsRpc(
    JSON.stringify({ "84532": ["https://a", "https://b"] }),
  );

  it("returns ordered urls for a supported chain", () => {
    expect(rpcUrlsForChainId(config, "84532")).toEqual([
      "https://a",
      "https://b",
    ]);
  });

  it("returns null for unsupported chain", () => {
    expect(rpcUrlsForChainId(config, "1")).toBeNull();
  });

  it("isChainIdSupported mirrors lookup", () => {
    expect(isChainIdSupported(config, "84532")).toBe(true);
    expect(isChainIdSupported(config, "999")).toBe(false);
    expect(supportedChainIds(config)).toEqual(["84532"]);
  });
});
