/**
 * JSON-RPC failover and error surfacing for `ethRpc` / `ethRpcWithFailover`.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import { ethRpc, ethRpcWithFailover } from "../src/eth-rpc.js";

describe("ethRpcWithFailover", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns result from the first successful endpoint", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url === "https://primary") {
        return new Response(
          JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0xabc" }),
          { status: 200 },
        );
      }
      throw new Error("should not reach fallback");
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await ethRpcWithFailover(
      ["https://primary", "https://fallback"],
      "eth_call",
      [],
    );
    expect(result).toBe("0xabc");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("tries the next url when the primary fails", async () => {
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        calls += 1;
        if (url === "https://primary") {
          return new Response("error", { status: 503 });
        }
        return new Response(
          JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x1" }),
          { status: 200 },
        );
      }),
    );

    const result = await ethRpcWithFailover(
      ["https://primary", "https://fallback"],
      "eth_getCode",
      [],
    );
    expect(result).toBe("0x1");
    expect(calls).toBe(2);
  });

  it("throws when all endpoints fail", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("nope", { status: 500 })),
    );

    await expect(
      ethRpcWithFailover(["https://a", "https://b"], "eth_call", []),
    ).rejects.toThrow(/all RPC endpoints failed/i);
  });
});

describe("ethRpc", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("surfaces JSON-RPC errors", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          jsonrpc: "2.0",
          id: 1,
          error: { message: "reverted" },
        }),
      ),
    );

    await expect(ethRpc("https://x", "eth_call", [])).rejects.toThrow(
      /reverted/,
    );
  });
});
