/**
 * GET /api/logs/{logId}/webhook JSON response.
 *
 * Omits secrets; URL validated at registration via
 * [@canopy/webhook-url](https://github.com/forestrie/canopy/tree/main/packages/libs/webhook-url).
 */

/** Public webhook configuration returned to control-plane clients. */
export interface WebhookConfigResponse {
  webhookUrl?: string;
  /** Univocity instance this log is bound to, when one was registered. */
  instanceKey?: string;
  /**
   * True when `webhookUrl` was copied from the instance-level webhook rather
   * than set directly on this log. Inherited URLs are the ones an instance
   * re-point rewrites.
   */
  inherited?: boolean;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
}
