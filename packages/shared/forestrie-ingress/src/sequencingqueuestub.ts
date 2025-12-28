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
   * Acknowledge a contiguous range of entries for a log.
   *
   * @param logId - Log identifier (16 bytes)
   * @param fromSeq - First seq to ack (inclusive)
   * @param toSeq - Last seq to ack (inclusive)
   * @returns Count of deleted entries
   */
  ackRange(
    logId: ArrayBuffer,
    fromSeq: number,
    toSeq: number,
  ): Promise<{ deleted: number }>;

  /**
   * Get queue statistics.
   *
   * @returns Current queue stats
   */
  stats(): Promise<QueueStats>;
}
