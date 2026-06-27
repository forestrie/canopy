/**
 * Per-log webhook and kill-switch configuration row shape.
 *
 * Stored in {@link DelegationStoreDO} `log_delegation_config` table.
 */

/** Internal webhook + enabled flags for a log (includes URL when set). */
export interface WebhookConfig {
  webhookUrl?: string;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
}
