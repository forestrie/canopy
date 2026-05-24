/** JSON body for POST /api/delegations/material. */
export interface SubmitMaterialRequest {
  logId: string;
  mmrStart: number;
  mmrEnd: number;
  /** Base64-encoded delegated public key CBOR bytes */
  delegatedPublicKey: string;
  /** Base64-encoded delegation certificate |certificate| COSE Sign1 bytes */
  certificate: string;
  issuedAt: number;
  expiresAt: number;
}
