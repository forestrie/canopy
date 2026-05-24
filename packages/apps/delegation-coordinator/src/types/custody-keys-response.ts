/** JSON response from Custodian create-key proxy. */
export interface CustodyKeysResponse {
  keyId: string;
  publicKey: string;
  alg: string;
}
