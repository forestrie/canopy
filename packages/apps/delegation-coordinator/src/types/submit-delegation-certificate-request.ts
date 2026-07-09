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
   * Base64 root-wallet signature over the univocity on-chain delegation
   * Sig_structure. The contract needs this proof whenever a delegated key
   * signs the checkpoint receipt (always, for sealer-produced checkpoints);
   * for KS256 roots it is unconditionally required since a secp256k1 address
   * cannot sign an ES256 receipt. Validation currently accepts KS256 roots
   * only (65-byte `r‖s‖v`, keccak256 digest, ecrecover/ERC-1271); the BYOK
   * ES256 variant (SHA-256/P-256) is not implemented. When present the
   * coordinator returns `onchainProof` from issue responses.
   */
  onchainSignature?: string;
}
