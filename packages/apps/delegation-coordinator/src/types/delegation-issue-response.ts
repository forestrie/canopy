/**
 * CBOR success response from POST /api/delegations.
 *
 * Returned when a stored certificate exists for the requested MMR range and
 * delegated key; otherwise a 202 pending problem is returned.
 */

/**
 * Univocity publishCheckpoint delegation material; CBOR keys must match arbor
 * `delegationcert.OnchainDelegationProof` struct tags exactly.
 */
export interface OnchainDelegationProofWire {
  protectedHeader: Uint8Array;
  delegationKey: Uint8Array;
  /** BigInt so cbor-x emits uint64, never float64 (Go uint64 decode). */
  mmrStart: bigint;
  /** BigInt so cbor-x emits uint64, never float64 (Go uint64 decode). */
  mmrEnd: bigint;
  signature: Uint8Array;
}

/** CBOR response from POST /api/delegations. */
export interface DelegationIssueResponse {
  version?: number;
  issuedAt: number;
  expiresAt: number;
  certificate?: Uint8Array;
  /** Present when the root wallet also signed the on-chain Sig_structure. */
  onchainProof?: OnchainDelegationProofWire;
}
