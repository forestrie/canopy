/**
 * Chain-scoped RPC selection for ERC-1271 verification (plan-2607-46 slice
 * 03, decisions Q3). The coordinator adopts ADR-0010 `SUPPORTED_CHAINS_RPC`
 * (`{chainId: [urls]}`); `KS256_RPC_URL` remains a deprecated single-URL
 * fallback for one release and is still `eth_chainId`-asserted, so a
 * wrong-chain endpoint can never answer for a log. Contract-root
 * verification with NO resolvable chain binding fails closed — EOA recovery
 * is chain-free and unaffected.
 */

import {
  createErc1271VerifyHooks,
  parseSupportedChainsRpc,
  rpcUrlsForChainId,
} from "@forestrie/chain-rpc";
import type { Erc1271VerifyHooks } from "@forestrie/chain-rpc";

/** Minimal env surface this module needs. */
export interface ChainRpcSelectionEnv {
  SUPPORTED_CHAINS_RPC?: string;
  KS256_RPC_URL?: string;
}

/** Parse a canonical `eip155:{chainId}:0x{40hex}` univocity instance id. */
export function chainIdFromUnivocityInstanceId(
  instanceId: string,
): string | null {
  const m = /^eip155:(\d+):0x[0-9a-f]{40}$/.exec(instanceId.trim());
  return m ? m[1]! : null;
}

let warnedDeprecatedFallback = false;

/**
 * Preference-ordered RPC URLs for one chain, or null when none configured.
 */
export function rpcUrlsForChain(
  env: ChainRpcSelectionEnv,
  chainId: string,
): string[] | null {
  const rawConfig = env.SUPPORTED_CHAINS_RPC?.trim();
  if (rawConfig) {
    try {
      const parsed = parseSupportedChainsRpc(rawConfig);
      const urls = rpcUrlsForChainId(parsed, chainId);
      if (urls?.length) return urls;
    } catch (error) {
      console.warn(
        JSON.stringify({
          tag: "supportedChainsRpcInvalid",
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  }
  const legacy = env.KS256_RPC_URL?.trim();
  if (legacy) {
    if (!warnedDeprecatedFallback) {
      warnedDeprecatedFallback = true;
      console.warn(
        JSON.stringify({
          tag: "ks256RpcUrlDeprecated",
          detail:
            "KS256_RPC_URL is a deprecated fallback; configure SUPPORTED_CHAINS_RPC (ADR-0010). The endpoint is still eth_chainId-asserted per log chain.",
        }),
      );
    }
    return [legacy];
  }
  return null;
}

/**
 * STRICT chain-asserted ERC-1271 hooks for a log's chain, or undefined when
 * no RPC is configured for it (contract roots then fail closed at the
 * caller). The `expectedChainId` assertion means even the deprecated
 * single-URL fallback cannot answer for the wrong chain.
 */
export function strictHooksForChain(
  env: ChainRpcSelectionEnv,
  chainId: string,
  options: { timeoutMs?: number } = {},
): Erc1271VerifyHooks | undefined {
  const urls = rpcUrlsForChain(env, chainId);
  if (!urls) return undefined;
  return createErc1271VerifyHooks(urls, {
    ...options,
    expectedChainId: chainId,
  });
}
