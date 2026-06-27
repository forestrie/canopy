/**
 * @deprecated Use {@link SubmitDelegationCertificateRequest}.
 */

/** @deprecated use SubmitDelegationCertificateRequest */
export interface SubmitMaterialRequest {
  logId: string;
  mmrStart: number;
  mmrEnd: number;
  /** Base64-encoded delegated public key CBOR bytes. */
  delegatedPublicKey: string;
  /** Base64-encoded delegation certificate COSE Sign1 bytes. */
  certificate: string;
  issuedAt: number;
  expiresAt: number;
}
