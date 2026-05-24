/** JSON body for POST /api/logs/{logId}/custody-keys. */
export interface CustodyKeysRequest {
  keyOwnerId: string;
  alg?: string;
  labels?: Record<string, string>;
}
