/**
 * ERC-1271 hooks factory: calldata shape, padded-word magic acceptance,
 * and error propagation (fail-closed callers depend on the throw).
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createErc1271VerifyHooks,
  encodeIsValidSignatureCall,
  Erc1271UnavailableError,
} from "../src/erc1271-verify-hooks.js";

const ADDRESS = new Uint8Array(20).fill(0xaa);
const HASH = new Uint8Array(32).fill(0x11);
const MAGIC_WORD = `0x1626ba7e${"0".repeat(56)}`;

function rpcResponse(result: string): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), {
    status: 200,
  });
}

describe("encodeIsValidSignatureCall", () => {
  it("encodes selector, hash, offset, length, and padded bytes", () => {
    // 65-byte signature pads to 96 bytes (3 words) of tail data.
    const signature = new Uint8Array(65).fill(0x22);
    const data = encodeIsValidSignatureCall(HASH, signature);
    expect(data.startsWith(`0x1626ba7e${"11".repeat(32)}`)).toBe(true);
    const words = data.slice(2 + 8 + 64).match(/.{64}/g)!;
    expect(words[0]).toBe("40".padStart(64, "0"));
    expect(words[1]).toBe("41".padStart(64, "0"));
    expect(words[4]!.startsWith("22")).toBe(true);
    expect(words[4]!.endsWith("0".repeat(62))).toBe(true);
    expect(data.length).toBe(2 + 8 + 64 * 6);
  });

  it("rejects a non-32-byte hash", () => {
    expect(() =>
      encodeIsValidSignatureCall(new Uint8Array(31), new Uint8Array(65)),
    ).toThrow("32 bytes");
  });
});

describe("createErc1271VerifyHooks", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("accepts the magic value as a right-padded 32-byte word", async () => {
    // Real nodes ABI-encode the bytes4 return — strict equality against
    // the bare selector would reject every genuine contract signature.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => rpcResponse(MAGIC_WORD)),
    );
    const hooks = createErc1271VerifyHooks(["https://rpc"]);
    await expect(
      hooks.isValidSignature(ADDRESS, HASH, new Uint8Array(96)),
    ).resolves.toBe(true);
  });

  it("rejects a non-magic return", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => rpcResponse(`0x${"ff".repeat(32)}`)),
    );
    const hooks = createErc1271VerifyHooks(["https://rpc"]);
    await expect(
      hooks.isValidSignature(ADDRESS, HASH, new Uint8Array(65)),
    ).resolves.toBe(false);
  });

  it("propagates RPC failure from isValidSignature", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("boom", { status: 503 })),
    );
    const hooks = createErc1271VerifyHooks(["https://rpc"]);
    await expect(
      hooks.isValidSignature(ADDRESS, HASH, new Uint8Array(65)),
    ).rejects.toThrow(Erc1271UnavailableError);
  });

  it("reports contract code presence and propagates getCode failure", async () => {
    const fetchMock = vi.fn(async () => rpcResponse("0x6001"));
    vi.stubGlobal("fetch", fetchMock);
    const hooks = createErc1271VerifyHooks(["https://rpc"]);
    await expect(hooks.hasContractCode(ADDRESS)).resolves.toBe(true);

    fetchMock.mockImplementation(async () => rpcResponse("0x"));
    await expect(hooks.hasContractCode(ADDRESS)).resolves.toBe(false);

    fetchMock.mockImplementation(
      async () => new Response("boom", { status: 500 }),
    );
    await expect(hooks.hasContractCode(ADDRESS)).rejects.toThrow(
      Erc1271UnavailableError,
    );
  });
});

describe("createErc1271VerifyHooks expectedChainId (plan-2607-46 slice 03)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // Each test uses a distinct URL: endpoint chain ids are memoized
  // per-isolate by URL, which is the production behavior under test.

  function stubChainAwareRpc(chainIdHex: string, callResult: string) {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: unknown, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as { method: string };
        calls.push(body.method);
        const result = body.method === "eth_chainId" ? chainIdHex : callResult;
        return rpcResponse(result);
      }),
    );
    return calls;
  }

  it("asserts eth_chainId once per endpoint and proceeds on match", async () => {
    const calls = stubChainAwareRpc("0x14a34", MAGIC_WORD);
    const hooks = createErc1271VerifyHooks(["https://match.rpc.test"], {
      expectedChainId: "84532",
    });
    await expect(
      hooks.isValidSignature(ADDRESS, HASH, new Uint8Array(65)),
    ).resolves.toBe(true);
    await expect(
      hooks.isValidSignature(ADDRESS, HASH, new Uint8Array(65)),
    ).resolves.toBe(true);
    expect(calls.filter((m) => m === "eth_chainId")).toHaveLength(1);
  });

  it("refuses an endpoint serving the wrong chain as unavailable", async () => {
    stubChainAwareRpc("0x1", MAGIC_WORD);
    const hooks = createErc1271VerifyHooks(["https://wrong.rpc.test"], {
      expectedChainId: "84532",
    });
    await expect(
      hooks.isValidSignature(ADDRESS, HASH, new Uint8Array(65)),
    ).rejects.toBeInstanceOf(Erc1271UnavailableError);
    await expect(hooks.hasContractCode(ADDRESS)).rejects.toBeInstanceOf(
      Erc1271UnavailableError,
    );
  });

  it("is byte-for-byte unchanged when the option is absent", async () => {
    const calls = stubChainAwareRpc("0x1", MAGIC_WORD);
    const hooks = createErc1271VerifyHooks(["https://unasserted.rpc.test"]);
    await expect(
      hooks.isValidSignature(ADDRESS, HASH, new Uint8Array(65)),
    ).resolves.toBe(true);
    expect(calls).not.toContain("eth_chainId");
  });

  it("a failed chain probe retries on the next call instead of sticking", async () => {
    let failing = true;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: unknown, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as { method: string };
        if (failing) throw new Error("rpc down");
        const result = body.method === "eth_chainId" ? "0x14a34" : MAGIC_WORD;
        return rpcResponse(result);
      }),
    );
    const hooks = createErc1271VerifyHooks(["https://flaky.rpc.test"], {
      expectedChainId: "84532",
    });
    await expect(hooks.hasContractCode(ADDRESS)).rejects.toBeInstanceOf(
      Erc1271UnavailableError,
    );
    failing = false;
    await expect(
      hooks.isValidSignature(ADDRESS, HASH, new Uint8Array(65)),
    ).resolves.toBe(true);
  });
});
