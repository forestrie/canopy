/**
 * JSON-RPC failover and error surfacing for `ethRpc` / `ethRpcWithFailover`.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import { ethCall, ethRpc, ethRpcWithFailover } from "../src/eth-rpc.js";

/**
 * Fetch that always throws. Stood in for `globalThis.fetch` for the
 * duration of a `fetchImpl` test so the assertion fails loudly if any
 * helper falls back to the global instead of the injected function.
 */
function forbiddenFetch(): never {
  throw new Error("global fetch must not be called when fetchImpl is set");
}

/**
 * Replace `globalThis.fetch` with {@link forbiddenFetch} for the duration
 * of `run`, restoring the original afterwards even if `run` throws.
 */
async function withGlobalFetchForbidden<T>(run: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = forbiddenFetch as unknown as typeof fetch;
  try {
    return await run();
  } finally {
    globalThis.fetch = original;
  }
}

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

describe("EthRpcOptions.fetchImpl", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("ethRpc calls the injected fetchImpl with the expected url and body, not globalThis.fetch", async () => {
    await withGlobalFetchForbidden(async () => {
      const fakeFetch = vi.fn(async (url: string, init?: RequestInit) => {
        expect(url).toBe("https://rpc.example/one");
        expect(JSON.parse(String(init?.body))).toMatchObject({
          jsonrpc: "2.0",
          method: "eth_call",
          params: [{ to: "0xdead" }, "latest"],
        });
        return new Response(
          JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0xabc" }),
          { status: 200 },
        );
      });

      const result = await ethRpc(
        "https://rpc.example/one",
        "eth_call",
        [{ to: "0xdead" }, "latest"],
        { fetchImpl: fakeFetch as unknown as typeof fetch },
      );

      expect(result).toBe("0xabc");
      expect(fakeFetch).toHaveBeenCalledTimes(1);
    });
  });

  it("ethCall threads fetchImpl through to ethRpc, not globalThis.fetch", async () => {
    await withGlobalFetchForbidden(async () => {
      const fakeFetch = vi.fn(async (url: string, init?: RequestInit) => {
        expect(url).toBe("https://rpc.example/two");
        expect(JSON.parse(String(init?.body))).toMatchObject({
          method: "eth_call",
          params: [{ to: "0xc0ffee", data: "0x1234" }, "latest"],
        });
        return new Response(
          JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0xresult" }),
          { status: 200 },
        );
      });

      const result = await ethCall(
        "https://rpc.example/two",
        "0xc0ffee",
        "0x1234",
        { fetchImpl: fakeFetch as unknown as typeof fetch },
      );

      expect(result).toBe("0xresult");
      expect(fakeFetch).toHaveBeenCalledTimes(1);
    });
  });

  it("ethRpcWithFailover threads fetchImpl to every attempt, not globalThis.fetch", async () => {
    await withGlobalFetchForbidden(async () => {
      const seenUrls: string[] = [];
      const fakeFetch = vi.fn(async (url: string) => {
        seenUrls.push(url);
        if (url === "https://primary.example") {
          return new Response("error", { status: 503 });
        }
        expect(url).toBe("https://fallback.example");
        return new Response(
          JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0xok" }),
          { status: 200 },
        );
      });

      const result = await ethRpcWithFailover(
        ["https://primary.example", "https://fallback.example"],
        "eth_getCode",
        ["0xdead", "latest"],
        { fetchImpl: fakeFetch as unknown as typeof fetch },
      );

      expect(result).toBe("0xok");
      expect(seenUrls).toEqual([
        "https://primary.example",
        "https://fallback.example",
      ]);
    });
  });
});
