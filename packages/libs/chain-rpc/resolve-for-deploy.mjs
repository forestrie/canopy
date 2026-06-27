/**
 * Deploy-time resolver for SUPPORTED_CHAINS_RPC (plain JS for apply-runtime-contract).
 * Logic mirrors @canopy/chain-rpc/src — keep in sync when changing substitution rules.
 */

const LITERAL_ENV_PREFIX = "\u0000LIT_ENV\u0000";
const INLINE_ENV_PATTERN = /\$\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g;
const CHAIN_ID_PATTERN = /^[1-9][0-9]*$/;

/** Strip // line comments and block comments from JSONC text. */
export function stripJsoncComments(text) {
  return text
    .split("\n")
    .filter((line) => !/^\s*\/\//.test(line))
    .join("\n")
    .replace(/\/\*[\s\S]*?\*\//g, "");
}

/** Remove trailing commas before `}` or `]` (JSONC → JSON). */
export function stripJsonTrailingCommas(text) {
  let result = text;
  let prev;
  do {
    prev = result;
    result = result.replace(/,(\s*[}\]])/g, "$1");
  } while (result !== prev);
  return result;
}

/** Normalize JSONC (comments + trailing commas) to strict JSON text. */
export function jsoncToJson(text) {
  return stripJsonTrailingCommas(stripJsoncComments(text));
}

export function substituteEnvTemplates(raw, env) {
  const escaped = raw.replace(/\\\$\{env:/g, LITERAL_ENV_PREFIX);
  const substituted = escaped.replace(INLINE_ENV_PATTERN, (_match, varName) => {
    const value = env[varName];
    if (value === undefined || value.length === 0) {
      throw new Error(`Missing environment variable: ${varName}`);
    }
    return value;
  });
  return substituted.replaceAll(LITERAL_ENV_PREFIX, "${env:");
}

export function parseSupportedChainsRpc(raw, options = {}) {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error("SUPPORTED_CHAINS_RPC is empty");
  }

  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new Error("SUPPORTED_CHAINS_RPC must be valid JSON");
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("SUPPORTED_CHAINS_RPC must be a JSON object");
  }

  const env = options.env ?? process.env;
  const resolveEnv = options.resolveEnv === true;
  const config = {};

  for (const [chainId, urls] of Object.entries(parsed)) {
    if (!CHAIN_ID_PATTERN.test(chainId)) {
      throw new Error(
        `Invalid chain id key "${chainId}": expected decimal EIP-155 string`,
      );
    }
    if (!Array.isArray(urls) || urls.length === 0) {
      throw new Error(
        `Chain ${chainId} must have a non-empty array of RPC URLs`,
      );
    }
    let list = urls.map((entry) => {
      if (typeof entry !== "string" || entry.trim().length === 0) {
        throw new Error(`Chain ${chainId} RPC URLs must be non-empty strings`);
      }
      return entry.trim();
    });
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
