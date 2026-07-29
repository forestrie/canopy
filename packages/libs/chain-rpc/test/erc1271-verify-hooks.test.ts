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
