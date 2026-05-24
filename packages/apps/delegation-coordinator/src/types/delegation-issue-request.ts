/** CBOR body for POST /api/delegations (arbor delegationcert). */
export interface DelegationIssueRequest {
  version?: number;
  domain?: string;
  chainId?: string;
  contractAddress?: string;
  logId: Uint8Array;
  mmrStart: number;
  mmrEnd: number;
  algorithm: string;
  delegatedPublicKey: Uint8Array;
  requestedTtlSeconds?: number;
  requestId?: Uint8Array;
}
