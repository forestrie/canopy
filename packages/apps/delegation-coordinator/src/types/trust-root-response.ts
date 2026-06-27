/**
 * CBOR trust-root response for GET /api/logs/{logId}/public-root.
 *
 * Wire format consumed by wallet-challenge session exchange and certificate
 * validation. ES256 legacy uses x/y; v2 uses COSE alg int and opaque key bytes
 * (KS256 address or ES256 x‖y) per
 * [univocity docs/arc](https://github.com/forestrie/univocity/blob/main/docs/arc/).
 */

/** CBOR body returned for a log's registered public root. */
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

/** COSE KS256 alg int for v2 wire encoding. */
export const COSE_ALG_KS256 = -65799;

/** COSE ES256 alg int for v2 wire encoding. */
export const COSE_ALG_ES256 = -7;
