/**
 * JSON response from Custodian ensure-key proxy.
 *
 * Returned after successful POST to custodian /api/keys via coordinator handler.
 */

/** Created or existing custody key metadata for a log owner. */
export interface CustodyKeysResponse {
  keyId: string;
  publicKey: string;
  alg: string;
}
