/**
 * Public exports for `@forestrie/chain-rpc`: supported-chains config parsing,
 * deploy-time env substitution, and JSON-RPC failover helpers shared by
 * canopy-api onboarding and KS256 verification.
 */

export type { EnvRecord } from "./substitute-env-templates.js";
export { substituteEnvTemplates } from "./substitute-env-templates.js";
export type {
  ParseSupportedChainsOptions,
  SupportedChainsConfig,
} from "./supported-chains-config.js";
export {
  isChainIdSupported,
  parseSupportedChainsRpc,
  rpcUrlsForChainId,
  supportedChainIds,
} from "./supported-chains-config.js";
export type { EthRpcOptions } from "./eth-rpc.js";
export {
  bytesToHex,
  ethCall,
  ethCallWithFailover,
  ethRpc,
  ethRpcWithFailover,
  hasContractCodeAt,
  hexAddressToBytes,
  normalizeHexAddress,
} from "./eth-rpc.js";
