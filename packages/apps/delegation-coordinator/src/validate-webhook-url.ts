/**
 * Webhook URL syntactic validation at registration time.
 *
 * Re-exports [@canopy/webhook-url](https://github.com/forestrie/canopy/tree/main/packages/libs/webhook-url)
 * — no DNS resolve or fetch at PUT /api/logs/{logId}/webhook.
 */

export {
  WebhookUrlValidationError,
  validateWebhookUrl,
  type ValidateWebhookUrlOptions,
} from "@canopy/webhook-url";
