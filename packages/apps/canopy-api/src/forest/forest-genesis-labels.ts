/**
 * Application-private CBOR map labels for `/api/forest/{log-id}/genesis` documents.
 * Standard COSE_Key map keys live in `cose/cose-key.ts`; Forestrie Sign1 uses -65538 elsewhere.
 */

/** `genesis-version`: uint; v1 is the only supported write schema today. */
export const FOREST_GENESIS_LABEL_GENESIS_VERSION = -68009;

/** `bootstrap-logid`: bstr 32, same wire as grant CBOR key 1. */
export const FOREST_GENESIS_LABEL_BOOTSTRAP_LOG_ID = -68010;

/** `univocity-addr`: bstr 20 (required on v1 POST). */
export const FOREST_GENESIS_LABEL_UNIVOCITY_ADDR = -68011;

/**
 * Legacy `univocity-chainids`: uint32[] — plan-0018; read-only for v0 objects.
 * Rejected on POST; use {@link FOREST_GENESIS_LABEL_CHAIN_ID} instead.
 */
export const FOREST_GENESIS_LABEL_UNIVOCITY_CHAIN_IDS = -68012;

/** `chain-id`: tstr decimal EIP-155 id (required on v1 POST). */
export const FOREST_GENESIS_LABEL_CHAIN_ID = -68013;

/** Stored genesis schema version for new POST writes. */
export const FOREST_GENESIS_SCHEMA_V1 = 1;

/** Dummy 20-byte contract address for tests and local e2e genesis POST. */
export const FOREST_GENESIS_E2E_DUMMY_UNIVOCITY_ADDR = new Uint8Array(20).fill(
  0xab,
);

/** Dummy chain id for tests and local e2e genesis POST. */
export const FOREST_GENESIS_E2E_DUMMY_CHAIN_ID = "84532";
