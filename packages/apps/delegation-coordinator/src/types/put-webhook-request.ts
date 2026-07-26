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
 * - `univocityInstanceId` — bind the log to a univocity instance and **copy**
 *   that instance's webhook into this log's config row (ADR-0005 amendment,
 *   "inherit by copy"). The value must be the canonical CAIP-10 form
 *   `eip155:{chainId}:0x{40 lowercase hex}` (ADR-0059 D1/D6). If the instance
 *   has no webhook yet the binding is still recorded, and the log picks the
 *   URL up on the next instance re-point.
 *
 * Registering nothing at all remains supported: a log with no webhook is never
 * sent `delegation.required` and its owner pre-supplies the delegation
 * instead.
 */
export interface PutWebhookRequest {
  url?: string;
  univocityInstanceId?: string;
  /**
   * Deprecated alias for `univocityInstanceId` (same canonical value rules,
   * same app-token requirement). Dropped in plan-2607-43 slice 05.
   */
  instanceKey?: string;
}
