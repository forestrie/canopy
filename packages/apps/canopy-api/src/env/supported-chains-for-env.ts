import {
  isChainIdSupported,
  parseSupportedChainsRpc,
  rpcUrlsForChainId,
  supportedChainIds,
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
