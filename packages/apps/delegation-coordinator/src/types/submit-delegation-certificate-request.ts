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
   * Base64 root signature over the univocity on-chain delegation
   * Sig_structure. The contract needs this proof whenever a delegated key
   * signs the checkpoint receipt (always, for sealer-produced checkpoints),
   * regardless of root algorithm. Validated against the stored public root:
   * KS256 roots submit 65-byte `r‖s‖v` (keccak256 digest, ecrecover or
   * ERC-1271); ES256 roots submit 64-byte IEEE P1363 `r‖s` (SHA-256 digest,
   * P-256; stored low-s normalized). When present the coordinator returns
   * `onchainProof` from issue responses. WebAuthn passkey roots (ES256 x/y
   * roots signing via an authenticator, univocity ADR-0008) submit the raw
   * 64-byte P1363 `r‖s` here too — never a container — alongside the two
   * assertion fields below.
   */
  onchainSignature?: string;
  /**
   * Base64 authenticatorData from the on-chain delegation assertion. Present
   * (with {@link onchainClientDataJSON}) iff the root signed the on-chain
   * proof as a WebAuthn assertion; the coordinator then verifies via the
   * ADR-0008 contract mirror and later re-assembles the proof's `algData`
   * from the stored parts. Requires an ES256 public root.
   */
  onchainAuthenticatorData?: string;
  /**
   * Base64 clientDataJSON from the on-chain delegation assertion, exactly as
   * the authenticator hashed it (its `challenge` binds the on-chain
   * delegation Sig_structure).
   */
  onchainClientDataJSON?: string;
}
