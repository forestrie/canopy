/**
 * ERC-1271 RPC hooks: a real node ABI-encodes the bytes4 magic to a
 * right-zero-padded 32-byte word — the hooks must accept it (a strict
 * equality against bare `0x1626ba7e` rejected every genuine Safe root
 * signature). RPC failures stay swallowed to `false` in this worker.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { createKs256RpcVerifyHooks } from "../../src/ks256-rpc-verify-hooks.js";

const ADDRESS = new Uint8Array(20).fill(0xaa);
const HASH = new Uint8Array(32).fill(0x11);
const SIGNATURE = new Uint8Array(96).fill(0x22);
const MAGIC_WORD = `0x1626ba7e${"0".repeat(56)}`;

function rpcResponse(result: string): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), {
    status: 200,
  });
}

describe("createKs256RpcVerifyHooks", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("accepts the padded magic word from a real node", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => rpcResponse(MAGIC_WORD)),
    );
    const hooks = createKs256RpcVerifyHooks("https://rpc.test");
    await expect(
      hooks.isValidSignature(ADDRESS, HASH, SIGNATURE),
    ).resolves.toBe(true);
  });

  it("rejects a non-magic return", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => rpcResponse(`0x${"00".repeat(32)}`)),
    );
    const hooks = createKs256RpcVerifyHooks("https://rpc.test");
    await expect(
      hooks.isValidSignature(ADDRESS, HASH, SIGNATURE),
    ).resolves.toBe(false);
  });

  it("swallows RPC failure to false on both hooks", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("boom", { status: 503 })),
    );
    const hooks = createKs256RpcVerifyHooks("https://rpc.test");
    await expect(hooks.hasContractCode(ADDRESS)).resolves.toBe(false);
    await expect(
      hooks.isValidSignature(ADDRESS, HASH, SIGNATURE),
    ).resolves.toBe(false);
  });

  it("reports contract code from eth_getCode", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => rpcResponse("0x6001")),
    );
    const hooks = createKs256RpcVerifyHooks("https://rpc.test");
    await expect(hooks.hasContractCode(ADDRESS)).resolves.toBe(true);
  });
});
