/**
 * Subplan 08 step 8.5a: Univocal checkpoint from Univocity contracts (viem).
 * Used for inclusion verification; do not use Arbor REST for this.
 */

import { createPublicClient, http, type Address, type Hex } from "viem";

export interface UnivocalCheckpointEnv {
  univocityContractRpcUrl: string;
  univocityContractAddress: string;
}

/** Checkpoint or MMR root for a log (shape depends on contract ABI). */
export interface UnivocalCheckpoint {
  /** MMR root (32 bytes) for the log. */
  mmrRoot: Hex;
}

/**
 * Get univocal checkpoint for ownerLogId from the Univocity contract via RPC.
 * Contract method is implementation-defined (e.g. getCheckpoint(logId) or getLogState(logId).mmrRoot).
 */
export async function getUnivocalCheckpointFromContracts(
  ownerLogIdHex: string,
  env: UnivocalCheckpointEnv,
): Promise<UnivocalCheckpoint | null> {
  const rpcUrl = env.univocityContractRpcUrl?.trim();
  const address = env.univocityContractAddress?.trim() as Address | undefined;
  if (!rpcUrl || !address) {
    throw new Error(
      "UNIVOCITY_CONTRACT_RPC_URL and UNIVOCITY_CONTRACT_ADDRESS required",
    );
  }

  const client = createPublicClient({
    transport: http(rpcUrl),
  });

  const logIdBytes32 = hexToBytes32(ownerLogIdHex);

  // Minimal ABI: assume contract has getCheckpoint(bytes32) or similar returning (bytes32 mmrRoot).
  // If the actual contract uses a different method name, update this.
  const abi = [
    {
      name: "getCheckpoint",
      type: "function",
      stateMutability: "view",
      inputs: [{ name: "logId", type: "bytes32", internalType: "bytes32" }],
      outputs: [{ name: "mmrRoot", type: "bytes32", internalType: "bytes32" }],
    },
  ] as const;

  try {
    const mmrRoot = await client.readContract({
      address,
      abi,
      functionName: "getCheckpoint",
      args: [logIdBytes32 as Hex],
    });
    return { mmrRoot: mmrRoot as Hex };
  } catch (e) {
    if (String(e).includes("revert") || String(e).includes("not found")) {
      return null;
    }
    throw e;
  }
}

function hexToBytes32(hex: string): Hex {
  const s = hex.replace(/^0x/i, "").trim().toLowerCase();
  if (s.length !== 64 || !/^[0-9a-f]+$/.test(s)) {
    throw new Error("ownerLogId must be 64 hex chars (32 bytes)");
  }
  return `0x${s}` as Hex;
}
