/**
 * @canopy/encoding — shared CBOR and COSE primitives and artifact encoders.
 * Plan 0003: one implementation per artifact; single file per primitive/artifact.
 */

export { encodeCborBstr } from "./encode-cbor-bstr.js";
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
  encodeCoseProtectedWithKid,
} from "./encode-cose-protected.js";
export { encodeCoseSign1Statement } from "./encode-cose-sign1-statement.js";
export { signCoseSign1Statement } from "./sign-cose-sign1-statement.js";
export {
  decodeCoseSign1,
  type DecodedCoseSign1,
  verifyCoseSign1,
} from "./verify-cose-sign1.js";
export {
  importTestPrivateKey,
  importTestPublicKey,
  TEST_ES256_PRIVATE_JWK,
  TEST_ES256_PUBLIC_JWK,
} from "./test-keys.js";
