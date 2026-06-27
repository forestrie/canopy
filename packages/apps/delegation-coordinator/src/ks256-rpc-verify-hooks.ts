/**
 * ERC-1271 JSON-RPC verify hooks for KS256 delegation certificates.
 *
 * Bridges {@link @forestrie/delegation-cose} KS256 verify to chain
 * `isValidSignature` per
 * [univocity docs/arc](https://github.com/forestrie/univocity/blob/main/docs/arc/).
 * Used when {@link Env.KS256_RPC_URL} is configured.
 */

import { encodeFunctionData, parseAbi } from "viem";
import type { Ks256VerifyHooks } from "@forestrie/delegation-cose";

/** Minimal ERC-1271 ABI for isValidSignature calls. */
const ERC1271_ABI = parseAbi([
  "function isValidSignature(bytes32 hash, bytes signature) view returns (bytes4)",
]);

/** Magic value returned by valid ERC-1271 signatures. */
const ERC1271_MAGIC = "0x1626ba7e";

/** Hex-encode bytes without 0x prefix. */
function bytesToHex(bytes: Uint8Array): string {
  let hex = "";
  for (const b of bytes) hex += b.toString(16).padStart(2, "0");
  return hex;
}

/**
 * Build ERC-1271 hooks from a JSON-RPC URL (coordinator worker).
 *
 * @param rpcUrl - HTTPS JSON-RPC endpoint (e.g. Base Sepolia).
 * @returns Hooks for KS256 certificate verification in Workers.
 */
export function createKs256RpcVerifyHooks(rpcUrl: string): Ks256VerifyHooks {
  return {
    async hasContractCode(address: Uint8Array): Promise<boolean> {
      try {
        const result = (await fetch(rpcUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "eth_getCode",
            params: [`0x${bytesToHex(address)}`, "latest"],
          }),
        }).then((r) => r.json())) as { result?: string };
        const code = result.result?.replace(/^0x/i, "") ?? "";
        return code.length > 0 && !/^0+$/.test(code);
      } catch {
        return false;
      }
    },
    async isValidSignature(
      address: Uint8Array,
      hash: Uint8Array,
      signature: Uint8Array,
    ): Promise<boolean> {
      try {
        const hashHex = `0x${bytesToHex(hash)}` as `0x${string}`;
        const sigHex = `0x${bytesToHex(signature)}` as `0x${string}`;
        const data = encodeFunctionData({
          abi: ERC1271_ABI,
          functionName: "isValidSignature",
          args: [hashHex, sigHex],
        });
        const callResult = (await fetch(rpcUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "eth_call",
            params: [{ to: `0x${bytesToHex(address)}`, data }, "latest"],
          }),
        }).then((r) => r.json())) as { result?: string };
        return callResult.result?.toLowerCase() === ERC1271_MAGIC;
      } catch {
        return false;
      }
    },
  };
}
