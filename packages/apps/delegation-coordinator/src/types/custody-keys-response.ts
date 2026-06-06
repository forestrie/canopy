/** JSON response from Custodian ensure-key proxy. */
export interface CustodyKeysResponse {
  keyId: string;
  publicKey: string;
  alg: string;
}
