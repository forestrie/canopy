/**
 * Application-private CBOR map labels for `/api/forest/{log-id}/genesis` documents.
 * Standard COSE_Key map keys live in `cose/cose-key.ts`; Forestrie Sign1 uses -65538 elsewhere.
 */

/** `bootstrap-logid`: bstr 32, same wire as grant CBOR key 1. */
export const FOREST_GENESIS_LABEL_BOOTSTRAP_LOG_ID = -68010;

/** `univocity-addr`: bstr 20 or null. */
export const FOREST_GENESIS_LABEL_UNIVOCITY_ADDR = -68011;

/** `univocity-chainids`: uint32[] or null. */
export const FOREST_GENESIS_LABEL_UNIVOCITY_CHAIN_IDS = -68012;
