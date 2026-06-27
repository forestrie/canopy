/**
 * CBOR success response from POST /api/delegations.
 *
 * Returned when a stored certificate exists for the requested MMR range and
 * delegated key; otherwise a 202 pending problem is returned.
 */

/** CBOR response from POST /api/delegations. */
export interface DelegationIssueResponse {
  version?: number;
  issuedAt: number;
  expiresAt: number;
  certificate?: Uint8Array;
}
