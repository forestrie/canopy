import { encodeFunctionData, parseAbi } from "viem";
import type { Ks256VerifyHooks } from "@forestrie/delegation-cose";

const ERC1271_ABI = parseAbi([
  "function isValidSignature(bytes32 hash, bytes signature) view returns (bytes4)",
]);
const ERC1271_MAGIC = "0x1626ba7e";

function bytesToHex(bytes: Uint8Array): string {
  let hex = "";
  for (const b of bytes) hex += b.toString(16).padStart(2, "0");
  return hex;
}

/** Build ERC-1271 hooks from a JSON-RPC URL (coordinator worker). */
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
        return (
          typeof callResult.result === "string" &&
          callResult.result
            .toLowerCase()
            .startsWith(ERC1271_MAGIC.toLowerCase())
        );
      } catch {
        return false;
      }
    },
  };
}
