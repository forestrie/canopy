export const FOREST_GENESIS_LABEL_GENESIS_VERSION = -68009;
export const FOREST_GENESIS_LABEL_GENESIS_ALG = -68014;
export const FOREST_GENESIS_LABEL_BOOTSTRAP_KEY = -68015;
/**
 * The forest's own log id, wire-encoded as 32 bytes: 16 zero bytes then the
 * 16-byte forest bootstrap log id (plan-2609-07 L3; mirrors mcp-resolve's
 * `genesis-binding.ts` naming so that consumer can import this instead of
 * defining it locally). See {@link decodeChainBindingFromGenesis}.
 */
export const FOREST_GENESIS_LABEL_LOG_ID = -68010;
export const FOREST_GENESIS_LABEL_UNIVOCITY_ADDR = -68011;
export const FOREST_GENESIS_LABEL_CHAIN_ID = -68013;
export const FOREST_GENESIS_SCHEMA_V2 = 2;
export const FOREST_GENESIS_SCHEMA_V1 = 1;

export const HEADER_IDTIMESTAMP = -65537;
export const HEADER_FORESTRIE_GRANT_V0 = -65538;
