import type { IndexEntry } from "./indexentry.js";

/**
 * Type definition for the SequencedContent Durable Object's RPC interface.
 *
 * This interface describes the methods callable via DO stub from other workers.
 * The actual implementation lives in @canopy/ranger-cache.
 */
export interface SequencedContentStub {
  /**
   * Resolve a content hash to its sequenced position.
   *
   * @param contentHash - SHA-256 hash of the statement content as bigint
   * @returns The index entry if found, or null if not in cache
   */
  resolveContent(contentHash: bigint): Promise<IndexEntry | null>;

  /**
   * Batch upsert sequenced entries from raw massif data.
   *
   * Directly enumerates the leaf table from the massif blob, avoiding
   * the overhead of serializing/deserializing records across RPC.
   * After upserting, if the total count exceeds the capacity limit
   * (2^(massifHeight-1)), oldest entries are evicted by idtimestamp.
   *
   * @param massifData - Raw massif blob bytes
   * @param massifHeight - The massif height (1-64)
   * @param massifIndex - The massif index (0-based)
   * @param start - Starting leaf ordinal (0-based, defaults to 0)
   * @param count - Number of leaves to process (defaults to all)
   * @returns Count of rows written
   */
  batchUpsertFromMassif(
    massifData: ArrayBuffer,
    massifHeight: number,
    massifIndex: number,
    start?: number,
    count?: number,
  ): Promise<{ count: number }>;
}
