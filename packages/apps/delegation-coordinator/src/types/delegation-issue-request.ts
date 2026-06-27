/**
 * CBOR request body for POST /api/delegations (delegation issue).
 *
 * Issued by [arbor sealer](https://github.com/forestrie/arbor/blob/main/services/sealer/)
 * when surfacing pending delegation; answered with certificate CBOR or 202
 * pending problem.
 */

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
