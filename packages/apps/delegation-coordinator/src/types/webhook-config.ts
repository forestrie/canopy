/** Per-log delegation webhook + kill-switch row in DelegationStoreDO. */
export interface WebhookConfig {
  webhookUrl?: string;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
}
