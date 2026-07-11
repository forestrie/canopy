/**
 * @forestrie/encoding — shared CBOR/COSE wire helpers consumed by canopy-api,
 * forestrie-ingress, and Custodian signing paths. One encoder per artifact;
 * sign and verify must share identical bytes (see {@link encodeSigStructure}).
 *
 * Grant and statement shapes align with
 * [grants.md](https://github.com/forestrie/canopy/blob/main/docs/grants.md)
 * and Univocity `PublishGrant` —
 * [ARC-0019](https://github.com/forestrie/devdocs/blob/main/arc/arc-0019-grant-verification-model.md).
 */

export { encodeCborBstr } from "./encode-cbor-bstr.js";
export { encodeSigStructure } from "./encode-sig-structure.js";
export {
  encodeGrantRequest,
  GRANT_REQUEST_KEYS,
  type GrantRequestInput,
} from "./encode-grant-request.js";
export {
  encodeProblemDetailsCbor,
  type ProblemDetail,
} from "./problem-details.js";
export {
  COSE_ALG,
  COSE_CTY,
  COSE_KID,
  type CoseProtectedHeaderOptions,
  encodeCoseProtectedMapBytes,
  encodeCoseProtectedWithKid,
} from "./encode-cose-protected.js";
export { encodeCoseSign1Statement } from "./encode-cose-sign1-statement.js";
export { signCoseSign1Statement } from "./sign-cose-sign1-statement.js";
export {
  algToCurve,
  COSE_ALG_ES256,
  COSE_ALG_KS256,
  type CoseAlgorithm,
  decodeCoseSign1,
  type DecodedCoseSign1,
  extractAlgFromProtected,
  type ParsedEcPublicKey,
  type ParsedVerifyKey,
  type VerifyCoseSign1Options,
  verifyCoseSign1,
  verifyCoseSign1WithParsedKey,
} from "./verify-cose-sign1.js";
export { coseUnprotectedToMap } from "./cose-unprotected-map.js";
export { encodeCoseSign1Raw } from "./encode-cose-sign1-raw.js";
export { mergeUnprotectedIntoCoseSign1 } from "./merge-cose-sign1-unprotected.js";

/**
 * Grant wire layer (ADR-0048): encoding is the single owner of grant wire
 * shapes and codecs. `@forestrie/grant-builder` (signs) and
 * `@forestrie/receipt-verify` (verifies) both import from here; neither
 * depends on the other.
 */

/** Grant wire type + grantData variants. */
export type { Grant } from "./grant.js";
export { grantDataToBytes } from "./grant-data.js";
export type { GrantData, GrantDataEs256Xy } from "./grant-data.js";

/** Grant CBOR encode/decode (Forestrie-Grant v0). */
export {
  decodeGrantPayload,
  decodeGrantResponse,
  encodeGrantForResponse,
  encodeGrantPayload,
} from "./grant-codec.js";

/** Canonical (tag-free) grant v0 payload CBOR + raw CBOR emit helpers. */
export {
  appendCborBstr,
  appendCborText,
  appendCborUint,
  encodeGrantPayloadV0Canonical,
  leftPadBytes,
} from "./grant-payload-canonical.js";

/** Log id (UUID) wire helpers. */
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
} from "./uuid-bytes.js";
export type { LogId } from "./uuid-bytes.js";
