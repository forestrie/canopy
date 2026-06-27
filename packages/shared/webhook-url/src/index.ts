/**
 * @canopy/webhook-url — syntactic webhook URL validation for register paths.
 * Validates shape and SSRF-sensitive hostnames only; no DNS resolution or fetch.
 */

export { WebhookUrlValidationError } from "./webhook-url-validation-error.js";
export type { ValidateWebhookUrlOptions } from "./validate-webhook-url-options.js";
export { validateWebhookUrl } from "./validate-webhook-url.js";
