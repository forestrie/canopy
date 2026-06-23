/** GET /api/logs/{logId}/enabled response */
export interface EnabledResponse {
  /** Effective availability: userEnabled AND operatorEnabled */
  enabled: boolean;
  userEnabled: boolean;
  operatorEnabled: boolean;
}
