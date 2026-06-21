/** Parameters for building a Forestrie delegation certificate. */
export interface DelegationInput {
  /** 32-character hex Forestrie log id. */
  logIdHex32: string;
  mmrStart: number;
  mmrEnd: number;
  /** CBOR-encoded delegated EC2 P-256 COSE_Key (integer-key map). */
  delegatedPublicKeyCbor: Uint8Array;
  issuedAt?: number;
  expiresAt?: number;
  /** 16 bytes recommended; random if omitted. */
  delegationId?: Uint8Array;
  constraints?: Record<string, unknown>;
  /** Used when issuedAt/expiresAt omitted (default 3600). */
  ttlSeconds?: number;
}
