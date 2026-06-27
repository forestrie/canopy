/**
 * PUT /api/logs/{logId}/webhook request body.
 */

/** HTTPS webhook URL for delegation.required notifications. */
export interface PutWebhookRequest {
  url: string;
}
