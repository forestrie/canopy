/**
 * ERC-1271 JSON-RPC verify hooks for KS256 delegation certificates.
 *
 * Bridges {@link @forestrie/delegation-cose} KS256 verify to chain
 * `isValidSignature` per
 * [univocity docs/arc](https://github.com/forestrie/univocity/blob/main/docs/arc/).
 * Used when {@link Env.KS256_RPC_URL} is configured.
 *
 * Delegates to the shared `@forestrie/chain-rpc` factory (plan-2607-45) —
 * one ERC-1271 implementation platform-wide. Notably the magic value must
 * be matched as a right-zero-padded word: `eth_call` returns the `bytes4`
 * ABI-encoded to 32 bytes, so strict equality against `0x1626ba7e` would
 * reject every genuine contract signature (e.g. a Safe root). RPC errors
 * are swallowed to `false` here (logged, never silent), preserving this
 * worker's existing fail-to-EOA-branch behavior; converging on canopy-api's
 * strict fail-closed shape rides the ADR-0010 `KS256_RPC_URL` →
 * supported-chains migration (plan-2607-09 C2, FOR-504 neighborhood).
 */

import { createErc1271VerifyHooks } from "@forestrie/chain-rpc";
import type { Ks256VerifyHooks } from "@forestrie/delegation-cose";

function warnSwallowed(operation: string, error: unknown): void {
  console.warn(
    JSON.stringify({
      tag: "ks256RpcVerifyHooksFailure",
      operation,
      error: error instanceof Error ? error.message : String(error),
    }),
  );
}

/**
 * Swallowing wrapper over STRICT ERC-1271 hooks: RPC failure logs and
 * verifies false, preserving the DO cert-verify fail-to-EOA-branch shape.
 */
export function swallowingKs256VerifyHooks(
  strict: import("@forestrie/chain-rpc").Erc1271VerifyHooks,
): Ks256VerifyHooks {
  return {
    async hasContractCode(address: Uint8Array): Promise<boolean> {
      try {
        return await strict.hasContractCode(address);
      } catch (error) {
        warnSwallowed("eth_getCode", error);
        return false;
      }
    },
    async isValidSignature(
      address: Uint8Array,
      hash: Uint8Array,
      signature: Uint8Array,
    ): Promise<boolean> {
      try {
        return await strict.isValidSignature(address, hash, signature);
      } catch (error) {
        warnSwallowed("isValidSignature", error);
        return false;
      }
    },
  };
}

/**
 * Build ERC-1271 hooks from a JSON-RPC URL (coordinator worker).
 *
 * @param rpcUrl - HTTPS JSON-RPC endpoint (e.g. Base Sepolia).
 * @returns Hooks for KS256 certificate verification in Workers.
 */
export function createKs256RpcVerifyHooks(rpcUrl: string): Ks256VerifyHooks {
  const hooks = createErc1271VerifyHooks([rpcUrl]);
  return {
    async hasContractCode(address: Uint8Array): Promise<boolean> {
      try {
        return await hooks.hasContractCode(address);
      } catch (error) {
        warnSwallowed("eth_getCode", error);
        return false;
      }
    },
    async isValidSignature(
      address: Uint8Array,
      hash: Uint8Array,
      signature: Uint8Array,
    ): Promise<boolean> {
      try {
        return await hooks.isValidSignature(address, hash, signature);
      } catch (error) {
        warnSwallowed("isValidSignature", error);
        return false;
      }
    },
  };
}
