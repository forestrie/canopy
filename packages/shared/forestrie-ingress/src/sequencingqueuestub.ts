import type { PullRequest } from "./pullrequest.js";
import type { PullResponse } from "./pullresponse.js";
import type { QueueStats } from "./queuestats.js";

/**
 * Extras object for enqueue.
 */
export interface EnqueueExtras {
  extra0?: ArrayBuffer;
  extra1?: ArrayBuffer;
  extra2?: ArrayBuffer;
  extra3?: ArrayBuffer;
}

/**
 * Type definition for the SequencingQueue Durable Object's RPC interface.
 *
 * This interface describes the methods callable via DO stub from canopy-api.
 * The actual implementation lives in canopy-api's durableobjects/sequencingqueue.ts.
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
   * See: arbor/docs/arc-cloudflare-do-ingress.md section 2.3 and 3.12
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
   * See: arbor/docs/arc-cloudflare-do-ingress.md section 3.12.5
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
}
