/**
 * Chain-scoped RPC selection (plan-2607-46 slice 03 / plan-2607-10 R6):
 * config precedence, instance-id parsing, and the deprecated
 * KS256_RPC_URL fallback — which must still be eth_chainId-asserted.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { Erc1271UnavailableError } from "@forestrie/chain-rpc";
import {
  chainIdFromUnivocityInstanceId,
  rpcUrlsForChain,
  strictHooksForChain,
} from "../../src/chain-rpc-selection.js";

const CONFIG =
  '{"84532":["https://cfg.rpc.test"],"1":["https://one.rpc.test"]}';

describe("chainIdFromUnivocityInstanceId", () => {
  it("parses the canonical CAIP-style id", () => {
    expect(
      chainIdFromUnivocityInstanceId(`eip155:84532:0x${"ab".repeat(20)}`),
    ).toBe("84532");
  });

  it("rejects malformed ids", () => {
    expect(chainIdFromUnivocityInstanceId("eip155:84532:0x1234")).toBeNull();
    expect(
      chainIdFromUnivocityInstanceId(`eip155:x:0x${"ab".repeat(20)}`),
    ).toBeNull();
    expect(chainIdFromUnivocityInstanceId("not-an-id")).toBeNull();
  });
});

describe("rpcUrlsForChain precedence", () => {
  it("SUPPORTED_CHAINS_RPC entry wins over the deprecated fallback", () => {
    expect(
      rpcUrlsForChain(
        { SUPPORTED_CHAINS_RPC: CONFIG, KS256_RPC_URL: "https://legacy.test" },
        "84532",
      ),
    ).toEqual(["https://cfg.rpc.test"]);
  });

  it("missing config entry falls back to KS256_RPC_URL", () => {
    expect(
      rpcUrlsForChain(
        { SUPPORTED_CHAINS_RPC: CONFIG, KS256_RPC_URL: "https://legacy.test" },
        "31337",
      ),
    ).toEqual(["https://legacy.test"]);
  });

  it("invalid config JSON falls back to KS256_RPC_URL", () => {
    expect(
      rpcUrlsForChain(
        {
          SUPPORTED_CHAINS_RPC: "not json",
          KS256_RPC_URL: "https://legacy.test",
        },
        "84532",
      ),
    ).toEqual(["https://legacy.test"]);
  });

  it("neither configured resolves null", () => {
    expect(rpcUrlsForChain({}, "84532")).toBeNull();
  });
});

describe("strictHooksForChain", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns undefined with no RPC configured", () => {
    expect(strictHooksForChain({}, "84532")).toBeUndefined();
  });

  it("the deprecated fallback is still eth_chainId-asserted", async () => {
    // Unique URL: endpoint chain ids are memoized per isolate.
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: unknown, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as { id: number };
        // Legacy endpoint answers mainnet while the log is bound to 84532.
        return new Response(
          JSON.stringify({ jsonrpc: "2.0", id: body.id, result: "0x1" }),
          { status: 200 },
        );
      }),
    );
    const hooks = strictHooksForChain(
      { KS256_RPC_URL: "https://legacy-wrongchain.rpc.test" },
      "84532",
    );
    expect(hooks).toBeDefined();
    await expect(
      hooks!.hasContractCode(new Uint8Array(20).fill(0x5a)),
    ).rejects.toBeInstanceOf(Erc1271UnavailableError);
  });

  it("the fallback serves when it answers the bound chain", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: unknown, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as {
          id: number;
          method: string;
        };
        const result =
          body.method === "eth_chainId" ? "0x14a34" : "0x600160005260206000f3";
        return new Response(
          JSON.stringify({ jsonrpc: "2.0", id: body.id, result }),
          { status: 200 },
        );
      }),
    );
    const hooks = strictHooksForChain(
      { KS256_RPC_URL: "https://legacy-rightchain.rpc.test" },
      "84532",
    );
    await expect(
      hooks!.hasContractCode(new Uint8Array(20).fill(0x5a)),
    ).resolves.toBe(true);
  });
});
