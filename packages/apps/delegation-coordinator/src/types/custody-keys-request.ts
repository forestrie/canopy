/**
 * JSON body for POST /api/logs/{logId}/custody-keys.
 *
 * Proxied to [arbor custodian](https://github.com/forestrie/arbor/blob/main/services/custodian/)
 * POST /api/keys for create-only key orchestration.
 */

/** Custodian ensure-key request from control-plane clients. */
export interface CustodyKeysRequest {
  keyOwnerId: string;
  alg?: string;
  labels?: Record<string, string>;
}
