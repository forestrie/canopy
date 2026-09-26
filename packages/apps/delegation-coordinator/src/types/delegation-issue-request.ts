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
  /**
   * Hex sha256 of each canonical COSE_Key the sealer currently holds the
   * private key for (its standing delegate keys, epochs N and N-1), the same
   * value the coordinator stores as `delegate_keys.pubkey_hash`. When present,
   * coverage retrieval serves only certificates bound to one of these keys
   * (or to `delegatedPublicKey`): a certificate bound to a key the sealer no
   * longer holds would be rejected by the sealer and, having been served,
   * would suppress the pending demand for the key it does hold (FOR-586).
   * Absent on older sealers, which get the pre-FOR-586 behaviour.
   */
  heldPublicKeyHashes?: string[];
}
