/**
 * Application-private CBOR map labels for `/api/forest/{log-id}/genesis` documents.
 * Standard COSE_Key map keys live in `cose/cose-key.ts`; Forestrie Sign1 uses -65538 elsewhere.
 */

/** `genesis-version`: uint; v2 is the only supported write schema today. */
export const FOREST_GENESIS_LABEL_GENESIS_VERSION = -68009;

/** `bootstrap-logid`: bstr 32, same wire as grant CBOR key 1. */
export const FOREST_GENESIS_LABEL_BOOTSTRAP_LOG_ID = -68010;

/** `univocity-addr`: bstr 20 (required on v2 POST). */
export const FOREST_GENESIS_LABEL_UNIVOCITY_ADDR = -68011;

/**
 * Legacy `univocity-chainids`: uint32[] — plan-0018; read-only for v0 objects.
 * Rejected on POST; use {@link FOREST_GENESIS_LABEL_CHAIN_ID} instead.
 */
export const FOREST_GENESIS_LABEL_UNIVOCITY_CHAIN_IDS = -68012;

/** `chain-id`: tstr decimal EIP-155 id (required on v2 POST). */
export const FOREST_GENESIS_LABEL_CHAIN_ID = -68013;

/** `genesisAlg`: int COSE alg (-7 ES256 or -65799 KS256); v2 POST. */
export const FOREST_GENESIS_LABEL_GENESIS_ALG = -68014;

/** `bootstrapKey`: bstr 64 (ES256 x‖y) or 20 (KS256 address); v2 POST. */
export const FOREST_GENESIS_LABEL_BOOTSTRAP_KEY = -68015;

/** Stored genesis schema version for legacy EC2 POST writes. */
export const FOREST_GENESIS_SCHEMA_V1 = 1;

/** Stored genesis schema version for alg/key POST writes (KS256 and ES256). */
export const FOREST_GENESIS_SCHEMA_V2 = 2;
