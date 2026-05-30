/** JSON body for POST /api/logs/{logId}/public-root. */
export interface SubmitPublicRootRequest {
  alg: "ES256";
  /** Base64-encoded P-256 coordinate x (32 bytes) */
  x: string;
  /** Base64-encoded P-256 coordinate y (32 bytes) */
  y: string;
}
