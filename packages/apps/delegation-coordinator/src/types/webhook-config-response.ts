/** GET /api/logs/{logId}/webhook response (no secret fields). */
export interface WebhookConfigResponse {
  webhookUrl?: string;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
}
