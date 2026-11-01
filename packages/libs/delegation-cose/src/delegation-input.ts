/**
 * Input parameters for assembling a Forestrie delegation certificate. Sealer
 * supplies log id, MMR bounds, and the ephemeral delegated public key; the log
 * root signs the resulting TBS via coordinator or BYOK upload — see
 * [plan-0035](https://github.com/forestrie/canopy/blob/main/docs/plans/plan-0035-delegation-cose-library.md).
 */

/** Parameters for building a Forestrie delegation certificate. */
export interface DelegationInput {
  /** 32-character hex Forestrie log id (payload label 1). */
  logIdHex32: string;
  /**
   * Inclusive MMR leaf index start (payload label 3); uint64, encoded as
   * CBOR major type 0.
   */
  mmrStart: bigint;
  /**
   * Exclusive MMR leaf index end (payload label 4); uint64, `>= mmrStart`.
   */
  mmrEnd: bigint;
  /** CBOR-encoded delegated EC2 P-256 COSE_Key (embedded inline at label 5). */
  delegatedPublicKeyCbor: Uint8Array;
  /** Unix seconds; defaults to now when omitted (payload label 8). */
  issuedAt?: number;
  /** Unix seconds; defaults to `issuedAt + ttlSeconds` when omitted (label 9). */
  expiresAt?: number;
  /** 16-byte correlation id (payload label 10); random when omitted. */
  delegationId?: Uint8Array;
  /** Opaque constraint map (payload label 6); empty object when omitted. */
  constraints?: Record<string, unknown>;
  /** Seconds of validity when `expiresAt` omitted; default 3600. */
  ttlSeconds?: number;
}
