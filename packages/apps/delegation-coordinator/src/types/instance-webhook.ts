/**
 * Instance-level webhook request/response shapes for
 * `/api/instances/{univocityInstanceId}/webhook`.
 */

/** PUT body — the instance-wide `delegation.required` endpoint. */
export interface PutInstanceWebhookRequest {
  url: string;
}

/**
 * Instance webhook state after a read or a re-point.
 *
 * `updatedLogs` is the number of member logs whose copied URL was rewritten by
 * this call, summed across shards — the fan-out that inherit-by-copy trades a
 * per-request cross-shard hop for.
 */
export interface InstanceWebhookResponse {
  univocityInstanceId: string;
  webhookUrl?: string;
  createdAt?: number;
  updatedAt?: number;
  /** Logs bound to this instance, summed across shards. */
  memberLogs?: number;
  /** Member logs rewritten by this call (PUT/DELETE only). */
  updatedLogs?: number;
  /** Shards the operation fanned out to (PUT/DELETE only). */
  shards?: number;
}
