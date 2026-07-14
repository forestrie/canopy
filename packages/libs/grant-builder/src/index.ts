/**
 * @forestrie/grant-builder — deterministic Forestrie grant construction:
 * `Authorization: Forestrie-Grant` header content, ES256 PEM and KS256
 * wallet grant assembly, and transparent statement shape assertions. No
 * HTTP, no env, no polling.
 *
 * The pure grant wire layer (`Grant`/`GrantData` types, payload/response
 * codecs, uuid wire helpers) lives in `@forestrie/encoding` (ADR-0048) and
 * is re-exported here for source compatibility; new code should import it
 * from `@forestrie/encoding`.
 *
 * Extracted from @forestrie/canopy-e2e-kit (plan-2607-12 Phase 2, FOR-350).
 * All modules are browser-safe except `es256-pem-grant.ts` (node:crypto; see
 * that module's header for why).
 */

/** Grant wire type + grantData variants (re-exported from @forestrie/encoding). */
export type { Grant } from "@forestrie/encoding";
export { grantDataToBytes } from "@forestrie/encoding";
export type { GrantData, GrantDataEs256Xy } from "@forestrie/encoding";

/** Grant flags (univocity alignment). */
export {
  authLogBootstrapShapedFlags,
  dataLogCreateExtendFlags,
  dataLogExtendFlags,
  derivedEndorsementGrantFlags,
  hasAuthLogClass,
  hasCreateAndExtend,
  hasDataLogClass,
  hasDerivedFlag,
  hasExtendCapability,
  isDataLogStatementGrantFlags,
  isDerivedEndorsementGrant,
} from "./grant-flags.js";

/** Grant CBOR encode/decode (Forestrie-Grant v0; re-exported from @forestrie/encoding). */
export {
  decodeGrantPayload,
  decodeGrantResponse,
  encodeGrantForResponse,
  encodeGrantPayload,
} from "@forestrie/encoding";

/** Canonical (tag-free) grant v0 payload CBOR (re-exported from @forestrie/encoding). */
export { encodeGrantPayloadV0Canonical } from "@forestrie/encoding";

/** Log id (UUID) wire helpers (re-exported from @forestrie/encoding). */
export {
  LOG_ID_BYTES,
  WIRE_LOG_ID_BYTES,
  bytesToUuid,
  fromPaddedWire32,
  logIdBytesToCustodianLowerHex,
  logIdToStorageSegment,
  parseLogIdSegment,
  toPaddedWire32,
  uuidToBytes,
} from "@forestrie/encoding";
export type { LogId } from "@forestrie/encoding";

/** SCITT transparent statement unprotected header labels (grants.md §3.2). */
export {
  HEADER_FORESTRIE_GRANT_V0,
  HEADER_IDTIMESTAMP,
  HEADER_RECEIPT,
} from "./transparent-statement.js";

/** Forestrie-Grant header base64 content. */
export { base64ToBytes, bytesToForestrieGrantBase64 } from "./grant-base64.js";

/** Transparent statement shape assertions. */
export {
  assertCustodianProfileTransparentStatement,
  assertRootGrantTransparentStatement,
} from "./transparent-statement-assert.js";

/** ES256 PEM grant assembly (node-only module). */
export {
  es256GrantData64FromPrivateKeyPem,
  signGrantPayloadWithEs256Pem,
} from "./es256-pem-grant.js";
export { mintEs256RootGrantWithBootstrapPem } from "./mint-es256-root-grant.js";

/** KS256 wallet grant assembly (browser-safe). */
export {
  KS256_PROTECTED_HEADER,
  ks256AddressFromPrivateKeyHex,
  mintKs256RootGrantWithWalletKey,
  randomKs256PrivateKeyHex,
  signGrantPayloadWithKs256Wallet,
  signGrantWithKs256WalletKey,
  signKs256RootStatement,
  verifyKs256GrantStatement,
} from "./ks256-wallet-grant.js";
