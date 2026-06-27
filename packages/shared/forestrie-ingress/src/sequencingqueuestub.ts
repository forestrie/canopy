import type { PullRequest } from "./pullrequest.js";
import type { PullResponse } from "./pullresponse.js";
import type { QueueStats } from "./queuestats.js";

/**
 * Optional extra fields attached at enqueue (each ≤32 bytes on wire).
 * Used by canopy-api register paths when posting to SequencingQueue.
 */
export interface EnqueueExtras {
  /** Optional extra field 0 (≤32 bytes on wire). */
  extra0?: ArrayBuffer;
  /** Optional extra field 1 (≤32 bytes on wire). */
  extra1?: ArrayBuffer;
  /** Optional extra field 2 (≤32 bytes on wire). */
  extra2?: ArrayBuffer;
  /** Optional extra field 3 (≤32 bytes on wire). */
  extra3?: ArrayBuffer;
}

/**
 * SequencingQueue Durable Object RPC contract (canopy-api stub calls).
 *
 * Implementation: `packages/apps/canopy-api` durableobjects/sequencingqueue.
 * HTTP pull/ack for ranger uses the same shapes via `@canopy/forestrie-ingress`.
 */
export interface SequencingQueueStub {
  /**
   * Enqueue a new entry for sequencing.
   *
   * @param logId - Log identifier (16 bytes)
   * @param contentHash - SHA-256 content hash (32 bytes)
   * @param extras - Optional extra fields (each ≤32 bytes)
   * @returns The assigned sequence number
   */
  enqueue(
    logId: ArrayBuffer,
    contentHash: ArrayBuffer,
    extras?: EnqueueExtras,
  ): Promise<{ seq: number }>;

  /**
   * Pull entries assigned to this poller.
   *
   * @param request - Pull parameters
   * @returns Grouped entries with lease expiry
   */
  pull(request: PullRequest): Promise<PullResponse>;

  /**
   * Acknowledge entries by marking them as sequenced.
   *
   * Updates the first N entries (by seq order) for the given log starting from
   * seqLo with their leaf indices. This is required because seq values are
   * allocated globally across all logs, making per-log seq values non-contiguous.
   *
   * massifIndex is derived: floor(leafIndex / (1 << massifHeight))
   *
   * See:
   * [ingress return path](https://github.com/forestrie/arbor/blob/main/docs/arc-cloudflare-do-ingress.md#312-return-path-unification)
   *
   * @param logId - Log identifier (16 bytes)
   * @param seqLo - Starting sequence number
   * @param limit - Number of entries to mark as sequenced
   * @param firstLeafIndex - Leaf index of the first entry
   * @param massifHeight - Massif height (log2 of leaves per massif)
   * @returns Count of entries marked as sequenced
   */
  ackFirst(
    logId: ArrayBuffer,
    seqLo: number,
    limit: number,
    firstLeafIndex: number,
    massifHeight: number,
  ): Promise<{ acked: number }>;

  /**
   * Resolve a content hash to its sequencing result.
   *
   * Returns the leaf_index and massif_index if the entry has been sequenced,
   * or null if still pending or unknown.
   *
   * See:
   * [resolveContent RPC](https://github.com/forestrie/arbor/blob/main/docs/arc-cloudflare-do-ingress.md#3125-resolvecontent)
   *
   * @param contentHash - SHA-256 content hash (32 bytes)
   * @returns Sequencing result or null if not yet sequenced
   */
  resolveContent(
    contentHash: ArrayBuffer,
  ): Promise<{ leafIndex: number; massifIndex: number } | null>;

  /**
   * Get the current pending count.
   * Used by shard discovery endpoint to report per-shard depth.
   *
   * @returns Number of pending entries
   */
  getPendingCount(): Promise<number>;

  /**
   * Get queue statistics.
   *
   * @returns Current queue stats
   */
  stats(): Promise<QueueStats>;

  /**
   * Dev/ops only: wipe durable storage and re-init an empty queue schema.
   * Guarded by HTTP in forestrie-ingress; not exposed via canopy-api.
   */
  devResetStorage(): Promise<void>;
}
