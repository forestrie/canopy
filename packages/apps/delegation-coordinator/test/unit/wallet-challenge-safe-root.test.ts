/**
 * Safe-root (contract-account) wallet-challenge verification (plan-2607-04
 * R1 / FOR-505): when the registered KS256 root has contract code, the
 * challenge signature is decided by ERC-1271 over the EIP-191 challenge
 * digest — personal_sign recovery can never match a contract root. RPC
 * outage is an availability outcome (`unavailable`), never a verdict.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { hashMessage, hexToBytes } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { createErc1271VerifyHooks } from "@forestrie/chain-rpc";
import { buildKs256ControlPlaneMessage } from "../../src/auth/wallet-challenge/challenge-message.js";
import { verifyKs256ControlPlaneSignatureForRoot } from "../../src/auth/wallet-challenge/verify-ks256.js";
import type { WalletChallengeEnvelope } from "../../src/types/wallet-challenge.js";

const TEST_PRIVATE_KEY =
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as const;

const SAFE_ROOT = new Uint8Array(20).fill(0x5a);
const MAGIC_WORD = `0x1626ba7e${"0".repeat(56)}`;
const NON_MAGIC_WORD = `0x${"0".repeat(64)}`;
const OWNER_SAFE_SIGNATURE = `0x${"11".repeat(32)}${"22".repeat(32)}1b`;

const envelope: WalletChallengeEnvelope = {
  version: "wcc-1",
  domain: "localhost",
  coordinatorOrigin: "http://localhost",
  authLogId: "11111111111111111111111111111111",
  scopes: ["delegations:read"],
  nonce: "safe-root-nonce",
  issuedAt: 1_785_300_000,
  expiresAt: 1_785_303_600,
};

interface RpcCall {
  method: string;
  params: unknown[];
}

/** JSON-RPC fetch stub: eth_getCode → `code`, eth_call → `callResult`. */
function stubRpc(code: string, callResult: string): RpcCall[] {
  const calls: RpcCall[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as RpcCall & { id: number };
      calls.push({ method: body.method, params: body.params });
      const result = body.method === "eth_getCode" ? code : callResult;
      return new Response(
        JSON.stringify({ jsonrpc: "2.0", id: body.id, result }),
        { status: 200 },
      );
    }),
  );
  return calls;
}

function strictHooks() {
  return createErc1271VerifyHooks(["https://rpc.test"]);
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("verifyKs256ControlPlaneSignatureForRoot — contract roots", () => {
  it("accepts when the root contract returns the ERC-1271 magic", async () => {
    const calls = stubRpc("0x6001", MAGIC_WORD);
    await expect(
      verifyKs256ControlPlaneSignatureForRoot(
        envelope,
        OWNER_SAFE_SIGNATURE,
        SAFE_ROOT,
        strictHooks(),
      ),
    ).resolves.toBe("valid");

    // The isValidSignature calldata must carry the EIP-191 digest of the
    // exact challenge message — the digest the console's SafeMessage wraps.
    const call = calls.find((c) => c.method === "eth_call");
    expect(call).toBeDefined();
    const calldata = (call!.params[0] as { data: string }).data;
    const digest = hashMessage(buildKs256ControlPlaneMessage(envelope));
    expect(calldata.toLowerCase()).toContain(digest.slice(2).toLowerCase());
    expect(calldata.toLowerCase()).toContain("1626ba7e");
  });

  it("returns signer_mismatch when the contract rejects the signature", async () => {
    stubRpc("0x6001", NON_MAGIC_WORD);
    await expect(
      verifyKs256ControlPlaneSignatureForRoot(
        envelope,
        OWNER_SAFE_SIGNATURE,
        SAFE_ROOT,
        strictHooks(),
      ),
    ).resolves.toBe("signer_mismatch");
  });

  it("returns unavailable (not a verdict) when every RPC fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("connect ECONNREFUSED");
      }),
    );
    await expect(
      verifyKs256ControlPlaneSignatureForRoot(
        envelope,
        OWNER_SAFE_SIGNATURE,
        SAFE_ROOT,
        strictHooks(),
      ),
    ).resolves.toBe("unavailable");
  });

  it("rejects malformed signature hex before calling the contract", async () => {
    stubRpc("0x6001", MAGIC_WORD);
    await expect(
      verifyKs256ControlPlaneSignatureForRoot(
        envelope,
        "not-hex",
        SAFE_ROOT,
        strictHooks(),
      ),
    ).resolves.toBe("invalid_signature");
  });
});

describe("verifyKs256ControlPlaneSignatureForRoot — EOA roots", () => {
  it("recovers personal_sign and matches the root (with hooks, code-less)", async () => {
    stubRpc("0x", NON_MAGIC_WORD);
    const account = privateKeyToAccount(TEST_PRIVATE_KEY);
    const signature = await account.signMessage({
      message: buildKs256ControlPlaneMessage(envelope),
    });
    const rootKey = hexToBytes(account.address);
    await expect(
      verifyKs256ControlPlaneSignatureForRoot(
        envelope,
        signature,
        rootKey,
        strictHooks(),
      ),
    ).resolves.toBe("valid");
  });

  it("without hooks, EOA recovery still works and a Safe root can never match", async () => {
    const account = privateKeyToAccount(TEST_PRIVATE_KEY);
    const signature = await account.signMessage({
      message: buildKs256ControlPlaneMessage(envelope),
    });
    await expect(
      verifyKs256ControlPlaneSignatureForRoot(
        envelope,
        signature,
        hexToBytes(account.address),
      ),
    ).resolves.toBe("valid");
    await expect(
      verifyKs256ControlPlaneSignatureForRoot(envelope, signature, SAFE_ROOT),
    ).resolves.toBe("signer_mismatch");
    await expect(
      verifyKs256ControlPlaneSignatureForRoot(envelope, "0x1234", SAFE_ROOT),
    ).resolves.toBe("invalid_signature");
  });
});
