/**
 * PUT /api/logs/{logId}/webhook request body.
 */

/**
 * Webhook registration for `delegation.required` notifications.
 *
 * At least one field must be present (both may be):
 *
 * - `url` — an explicit HTTPS per-log webhook. Recorded with source `log`; an
 *   instance re-point never overwrites it.
 * - `instanceKey` — bind the log to a univocity instance and **copy** that
 *   instance's webhook into this log's config row (ADR-0005 amendment,
 *   "inherit by copy"). If the instance has no webhook yet the binding is
 *   still recorded, and the log picks the URL up on the next instance
 *   re-point.
 *
 * Registering nothing at all remains supported: a log with no webhook is never
 * sent `delegation.required` and its owner pre-supplies the delegation
 * instead.
 */
export interface PutWebhookRequest {
  url?: string;
  instanceKey?: string;
}
