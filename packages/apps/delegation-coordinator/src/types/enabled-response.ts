/**
 * GET /api/logs/{logId}/enabled response types.
 *
 * User and operator kill-switches combine into effective `enabled` for
 * pending surfacing and webhook delivery.
 */

/** Per-log delegation availability flags. */
export interface EnabledResponse {
  /** Effective availability: userEnabled AND operatorEnabled. */
  enabled: boolean;
  userEnabled: boolean;
  operatorEnabled: boolean;
}
