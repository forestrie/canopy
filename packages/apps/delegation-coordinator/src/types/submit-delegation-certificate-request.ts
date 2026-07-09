/**
 * JSON body for POST /api/delegations/certificate (runner submission).
 *
 * Validated by {@link validateByokDelegationCertificate} before persistence
 * in {@link DelegationStoreDO}. {@link issuedAt} and {@link expiresAt} must
 * match the signed COSE payload (fields 8 and 9).
 */

/** Runner-submitted BYOK delegation certificate for storage. */
export interface SubmitDelegationCertificateRequest {
  logId: string;
  mmrStart: number;
  mmrEnd: number;
  /** Base64-encoded delegated public key CBOR bytes. */
  delegatedPublicKey: string;
  /** Base64-encoded delegation certificate COSE Sign1 bytes. */
  certificate: string;
  issuedAt: number;
  expiresAt: number;
  /**
   * Base64 65-byte `r‖s‖v` KS256 signature over the univocity on-chain
   * delegation Sig_structure (keccak256 digest). KS256 roots only; when
   * present the coordinator returns `onchainProof` from issue responses.
   */
  onchainSignature?: string;
}
