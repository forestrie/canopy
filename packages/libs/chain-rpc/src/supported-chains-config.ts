/**
 * Parse and query `SUPPORTED_CHAINS_RPC` — deployment-wide chain capability map.
 * Keys are supported EIP-155 chain ids; per-forest Univocity binding stays
 * `(chainId, addr)` per
 * [devdocs ADR-0034](https://github.com/forestrie/devdocs/blob/main/adr/adr-0034-forest-genesis-chain-binding-required.md).
 * Template: `packages/apps/canopy-api/config/supported-chains.jsonc`. Downstream:
 * canopy-api onboard validation, KS256 ERC-1271, receipt authority resolver.
 */

import {
  substituteEnvTemplates,
  type EnvRecord,
} from "./substitute-env-templates.js";

/**
 * Decimal EIP-155 chain id string → preference-ordered RPC URL list for that
 * chain.
 */
export type SupportedChainsConfig = Record<string, string[]>;

/** Options for {@link parseSupportedChainsRpc}. */
export interface ParseSupportedChainsOptions {
  /** When true, resolve `${env:VAR}` in each URL (deploy / local preflight). */
  resolveEnv?: boolean;
  /** Variable map for template resolution; defaults to `{}` when omitted. */
  env?: EnvRecord;
}

/** Valid decimal EIP-155 chain id keys (non-zero, no hex prefix). */
const CHAIN_ID_PATTERN = /^[1-9][0-9]*$/;

/**
 * Validate object key is a non-zero decimal EIP-155 chain id string.
 *
 * @param key - JSON object key from `SUPPORTED_CHAINS_RPC`.
 * @throws When the key is not a valid decimal chain id.
 */
function assertChainIdKey(key: string): void {
  if (!CHAIN_ID_PATTERN.test(key)) {
    throw new Error(
      `Invalid chain id key "${key}": expected decimal EIP-155 string`,
    );
  }
}

/**
 * Validate and trim the URL array for one chain entry.
 *
 * @param chainId - Chain id being validated (for error messages).
 * @param urls - Raw JSON array value for that chain.
 * @returns Trimmed non-empty URL strings.
 * @throws When the list is missing, empty, or contains invalid entries.
 */
function assertUrlList(chainId: string, urls: unknown): string[] {
  if (!Array.isArray(urls) || urls.length === 0) {
    throw new Error(`Chain ${chainId} must have a non-empty array of RPC URLs`);
  }
  const out: string[] = [];
  for (const entry of urls) {
    if (typeof entry !== "string" || entry.trim().length === 0) {
      throw new Error(`Chain ${chainId} RPC URLs must be non-empty strings`);
    }
    out.push(entry.trim());
  }
  return out;
}

/**
 * Parse `SUPPORTED_CHAINS_RPC` JSON. At runtime the Worker receives
 * already-resolved URLs; deploy uses `resolveEnv: true`.
 *
 * @param raw - JSON object string mapping chain ids to URL arrays.
 * @param options - When `resolveEnv` is true, substitute `${env:VAR}` using
 *   `options.env` (see {@link substituteEnvTemplates}).
 * @returns Validated chain id → URL list map.
 * @throws When JSON is invalid, keys or URL lists fail validation, or the map
 *   is empty.
 */
export function parseSupportedChainsRpc(
  raw: string,
  options: ParseSupportedChainsOptions = {},
): SupportedChainsConfig {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error("SUPPORTED_CHAINS_RPC is empty");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed) as unknown;
  } catch {
    throw new Error("SUPPORTED_CHAINS_RPC must be valid JSON");
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("SUPPORTED_CHAINS_RPC must be a JSON object");
  }

  const env = options.env ?? {};
  const resolveEnv = options.resolveEnv === true;
  const config: SupportedChainsConfig = {};

  for (const [chainId, urls] of Object.entries(
    parsed as Record<string, unknown>,
  )) {
    assertChainIdKey(chainId);
    let list = assertUrlList(chainId, urls);
    if (resolveEnv) {
      list = list.map((url) => substituteEnvTemplates(url, env));
    }
    config[chainId] = list;
  }

  if (Object.keys(config).length === 0) {
    throw new Error("SUPPORTED_CHAINS_RPC must define at least one chain");
  }

  return config;
}

/**
 * Look up preference-ordered RPC URLs for a chain id.
 *
 * @param config - Parsed supported-chains map.
 * @param chainId - Decimal chain id (trimmed before lookup).
 * @returns URL list or `null` when the chain is not configured.
 */
export function rpcUrlsForChainId(
  config: SupportedChainsConfig,
  chainId: string,
): string[] | null {
  const urls = config[chainId.trim()];
  if (!urls || urls.length === 0) return null;
  return urls;
}

/**
 * Whether the deployment supports a chain id (non-empty URL list present).
 *
 * @param config - Parsed supported-chains map.
 * @param chainId - Decimal chain id to check.
 */
export function isChainIdSupported(
  config: SupportedChainsConfig,
  chainId: string,
): boolean {
  return rpcUrlsForChainId(config, chainId) !== null;
}

/**
 * All supported chain ids (object keys) for listing and validation.
 *
 * @param config - Parsed supported-chains map.
 */
export function supportedChainIds(config: SupportedChainsConfig): string[] {
  return Object.keys(config);
}
