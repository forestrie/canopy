/**
 * Syntactic webhook URL validation at registration (no DNS resolve, no fetch).
 */

export {
  WebhookUrlValidationError,
  validateWebhookUrl,
  type ValidateWebhookUrlOptions,
} from "@canopy/webhook-url";
