/**
 * Public API for `@forestrie/delegation-cose` — assemble and verify Forestrie
 * delegation COSE Sign1 certificates (ES256 and KS256). Canonical wire format
 * matches arbor
 * [delegationcert](https://github.com/forestrie/arbor/tree/main/services/pkgs/delegationcert);
 * consumed by delegation-coordinator BYOK validation and sealer verification.
 * Spec: [plan-0035](https://github.com/forestrie/canopy/blob/main/docs/plans/plan-0035-delegation-cose-library.md).
 */

export type { CertificateInfo } from "./certificate-info.js";
export type { DelegationInput } from "./delegation-input.js";
export type { DelegationToBeSigned } from "./delegation-tbs.js";
export type { Ks256VerifyHooks } from "./ks256-verify-hooks.js";
export type { ParsedDelegatedKey } from "./parsed-delegated-key.js";
export type { SignEs256 } from "./build-delegation-certificate-es256.js";
export type { SignKs256 } from "./build-delegation-certificate-ks256.js";

export { DELEGATION_CONTENT_TYPE } from "./delegation-content-type.js";
export {
  COSE_ALG_ES256,
  COSE_ALG_KS256,
  COSE_CRV,
  COSE_CRV_P256,
  COSE_KTY,
  COSE_KTY_EC2,
  COSE_X,
  COSE_Y,
  PAYLOAD_DELEGATED_KEY,
} from "./payload-labels.js";

export type {
  OnchainDelegationInput,
  OnchainDelegationProofParts,
  OnchainDelegationToBeSigned,
} from "./build-onchain-delegation.js";
export {
  ONCHAIN_DELEGATION_DOMAIN,
  buildOnchainDelegationToBeSignedEs256,
  buildOnchainDelegationToBeSignedKs256,
  normalizeEs256SignatureLowS,
  signOnchainDelegationEs256,
  signOnchainDelegationKs256,
  verifyOnchainDelegationSignatureEs256,
  verifyOnchainDelegationSignatureKs256,
} from "./build-onchain-delegation.js";

export { assembleDelegationCertificate } from "./assemble-certificate.js";
export {
  buildDelegationCertificateEs256,
  buildDelegationCertificateEs256WithSigner,
} from "./build-delegation-certificate-es256.js";
export {
  buildDelegationCertificateKs256,
  buildDelegationCertificateKs256WithSigner,
} from "./build-delegation-certificate-ks256.js";
export {
  buildDelegationToBeSignedEs256,
  deriveEs256KidFromPublicKey,
} from "./build-tbs-es256.js";
export { buildDelegationToBeSignedKs256 } from "./build-tbs-ks256.js";
export { parseDelegationCertificate } from "./parse-certificate.js";
export {
  assertDelegatedKeyInCertificate,
  decodeCoseSign1Parts,
  decodeDelegatedCoseKeyFromBytes,
  normalizeIntKeyedMap,
  parseDelegatedCoseKeyFromPayload,
} from "./parse-delegated-cose-key.js";
export { verifyDelegationCertificateEs256 } from "./verify-es256.js";
export { verifyDelegationCertificateKs256 } from "./verify-ks256.js";
export { encodeIntKeyCbor } from "./encode-int-map.js";
