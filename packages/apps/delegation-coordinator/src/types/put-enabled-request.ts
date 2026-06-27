/**
 * PUT /api/logs/{logId}/enabled request body.
 */

/** Boolean kill-switch write for user or operator authority. */
export interface PutEnabledRequest {
  enabled: boolean;
}
