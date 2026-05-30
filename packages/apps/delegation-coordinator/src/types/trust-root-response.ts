/**
 * CBOR trust-root response for GET /api/logs/{logId}/public-root.
 *
 * Wire shape matches arbor/services/sealer/src/trust_root_response.go
 * (TrustRootResponse). Chain-provenance fields are optional placeholders.
 */
export interface TrustRootResponseCbor {
  logId: Uint8Array;
  alg: string;
  x: Uint8Array;
  y: Uint8Array;
  chainId?: string;
  contractAddress?: string;
  domain?: string;
}
