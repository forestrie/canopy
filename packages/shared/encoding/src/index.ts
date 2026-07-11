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
  COSE_KID,
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
export {
  importTestPrivateKey,
  importTestPublicKey,
  TEST_ES256_PRIVATE_JWK,
  TEST_ES256_PUBLIC_JWK,
} from "./test-keys.js";
