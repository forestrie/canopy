/** JSON body for POST /api/logs/{logId}/public-root. */
export interface SubmitPublicRootRequest {
  /** ES256 legacy: `"ES256"`. KS256 / ES256 v2: COSE alg int (-65799 or -7). */
  alg: "ES256" | number;
  /** Base64-encoded P-256 coordinate x (32 bytes); ES256 legacy only. */
  x?: string;
  /** Base64-encoded P-256 coordinate y (32 bytes); ES256 legacy only. */
  y?: string;
  /** Base64 opaque root key: 64 bytes (ES256 x‖y) or 20 bytes (KS256 address). */
  key?: string;
}
