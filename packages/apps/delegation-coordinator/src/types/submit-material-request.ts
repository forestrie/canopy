/**
 * @deprecated Use {@link SubmitDelegationCertificateRequest}.
 */

/** @deprecated use SubmitDelegationCertificateRequest */
export interface SubmitMaterialRequest {
  logId: string;
  /** Canonical decimal uint64 string. */
  mmrStart: string;
  /** Canonical decimal uint64 string. */
  mmrEnd: string;
  /** Base64-encoded delegated public key CBOR bytes. */
  delegatedPublicKey: string;
  /** Base64-encoded delegation certificate COSE Sign1 bytes. */
  certificate: string;
  issuedAt: number;
  expiresAt: number;
}
