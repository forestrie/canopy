/**
 * GET /api/logs/{logId}/webhook JSON response.
 *
 * Omits secrets; URL validated at registration via
 * [@canopy/webhook-url](https://github.com/forestrie/canopy/tree/main/packages/libs/webhook-url).
 */

/** Public webhook configuration returned to control-plane clients. */
export interface WebhookConfigResponse {
  webhookUrl?: string;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
}
