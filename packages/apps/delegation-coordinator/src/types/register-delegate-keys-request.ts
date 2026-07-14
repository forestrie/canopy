/**
 * JSON body for POST /api/sealer/delegate-keys (FOR-390 phase C).
 *
 * Registers/refreshes a sealer's standing delegate keys so coverage retrieval
 * (POST /api/delegations) can bind a wide advance certificate to a delegate
 * key across rotation. Idempotent upsert keyed by the key's hash.
 *
 * The hash the coordinator stores (`pubkey_hash`) is
 * `sha256(publicKey CBOR bytes)` — identical to how
 * {@link SubmitDelegationCertificateRequest.delegatedPublicKey} is hashed into
 * `delegation_certificates.delegated_pubkey_hash`. For the coverage JOIN to
 * match, {@link RegisterDelegateKey.publicKey} MUST therefore be the same
 * COSE_Key CBOR encoding the sealer binds into its certificates — NOT a raw
 * `x||y` point. (Reconciling the sealer-side encoding with this contract is a
 * Phase D task; Phase B registration is best-effort and not yet load-bearing.)
 */

/** One standing delegate key to register. */
export interface RegisterDelegateKey {
  /** COSE algorithm label; only "ES256" is accepted today. */
  alg: string;
  /** Base64 COSE_Key CBOR bytes of the delegate public key. */
  publicKey: string;
  /** Operator-bumped rotation epoch (>= 1). */
  epoch: number;
  /** Unix seconds after which the key is retired and dropped. */
  notAfter: number;
  /**
   * Base64 untagged COSE_Sign1 custodian voucher over (sealerId, epoch,
   * publicKey), signed by the registrar voucher key. Required (FOR-390 phase
   * G/H): the coordinator verifies it against `PINNED_REGISTRAR_KEY` before
   * accepting, so only the custodian — not any COORDINATOR_APP_TOKEN holder —
   * can introduce a delegate key the coordinator will advertise.
   */
  voucher: string;
}

/** Sealer standing delegate-key registration. */
export interface RegisterDelegateKeysRequest {
  sealerId: string;
  keys: RegisterDelegateKey[];
}
