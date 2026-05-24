/** CBOR response from POST /api/delegations. */
export interface DelegationIssueResponse {
  version?: number;
  issuedAt: number;
  expiresAt: number;
  certificate?: Uint8Array;
}
