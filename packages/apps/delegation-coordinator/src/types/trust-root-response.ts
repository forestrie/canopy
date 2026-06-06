/**
 * CBOR trust-root response for GET /api/logs/{logId}/public-root.
 *
 * v1: `{ logId, alg: "ES256", x, y }` (legacy ES256).
 * v2: `{ logId, alg: -7 | -65799, key }` (opaque root key bytes).
 */
export interface TrustRootResponseCbor {
  logId: Uint8Array;
  alg: string | number;
  x?: Uint8Array;
  y?: Uint8Array;
  key?: Uint8Array;
  chainId?: string;
  contractAddress?: string;
  domain?: string;
}

/** COSE KS256 alg int for v2 wire. */
export const COSE_ALG_KS256 = -65799;

/** COSE ES256 alg int for v2 wire. */
export const COSE_ALG_ES256 = -7;
