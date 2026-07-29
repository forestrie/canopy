import {
  createErc1271VerifyHooks,
  isChainIdSupported,
  parseSupportedChainsRpc,
  rpcUrlsForChainId,
  supportedChainIds,
  type Erc1271VerifyHooks,
  type EthRpcOptions,
  type SupportedChainsConfig,
} from "@forestrie/chain-rpc";

export interface SupportedChainsEnv {
  SUPPORTED_CHAINS_RPC?: string;
}

let cached: { raw: string; config: SupportedChainsConfig } | undefined;

export function supportedChainsConfigForEnv(
  env: SupportedChainsEnv,
): SupportedChainsConfig | null {
  const raw = env.SUPPORTED_CHAINS_RPC?.trim();
  if (!raw) return null;
  if (cached?.raw === raw) return cached.config;
  const config = parseSupportedChainsRpc(raw);
  cached = { raw, config };
  return config;
}

export function rpcUrlsForEnvChainId(
  env: SupportedChainsEnv,
  chainId: string,
): string[] | null {
  const config = supportedChainsConfigForEnv(env);
  if (!config) return null;
  return rpcUrlsForChainId(config, chainId);
}

/**
 * ERC-1271 verify hooks for a KS256 root on the binding chain, or
 * `undefined` when no RPC is configured for it (verification is then
 * EOA-only; a contract-account root cannot validate without RPC).
 */
export function erc1271HooksForEnvChainId(
  env: SupportedChainsEnv,
  chainId: string,
  options: EthRpcOptions = {},
): Erc1271VerifyHooks | undefined {
  const rpcUrls = rpcUrlsForEnvChainId(env, chainId);
  return rpcUrls?.length
    ? createErc1271VerifyHooks(rpcUrls, options)
    : undefined;
}

export function isSupportedChainIdForEnv(
  env: SupportedChainsEnv,
  chainId: string,
): boolean {
  const config = supportedChainsConfigForEnv(env);
  if (!config) return false;
  return isChainIdSupported(config, chainId);
}

export function supportedChainIdsForEnv(env: SupportedChainsEnv): string[] {
  const config = supportedChainsConfigForEnv(env);
  if (!config) return [];
  return supportedChainIds(config);
}

/** Reset isolate cache (tests). */
export function resetSupportedChainsCacheForTests(): void {
  cached = undefined;
}
