/**
 * Sharding helpers for SequencingQueue Durable Object routing.
 *
 * Deterministic logId → shard mapping used by canopy-api (enqueue) and
 * forestrie-ingress (pull). Design:
 * [ADR-0006](https://github.com/forestrie/arbor/blob/main/docs/adr/adr-0006-cf-do-ingress-sharding.md),
 * [ADR-0012](https://github.com/forestrie/arbor/blob/main/docs/adr/adr-0012-cf-do-ingress-shard-discovery.md).
 */

/**
 * Compute djb2 hash of a string.
 *
 * djb2 is a fast, non-cryptographic hash function with good distribution.
 * The result is an unsigned 32-bit integer.
 *
 * @param str - Input string (typically a UUID logId)
 * @returns Unsigned 32-bit hash value
 */
export function hashLogId(logId: string): number {
  let hash = 5381;
  for (let i = 0; i < logId.length; i++) {
    // hash * 33 + char, using bit shift for multiplication
    hash = ((hash << 5) + hash + logId.charCodeAt(i)) >>> 0;
  }
  return hash;
}

/**
 * Compute the shard index for a given logId.
 *
 * All entries for a single log will be routed to the same shard,
 * preserving per-log ordering guarantees.
 *
 * @param logId - Log identifier (UUID string)
 * @param shardCount - Total number of shards (must be >= 1)
 * @returns Shard index in range [0, shardCount - 1]
 */
export function shardIndexForLog(logId: string, shardCount: number): number {
  if (shardCount < 1) {
    throw new Error(`shardCount must be >= 1, got ${shardCount}`);
  }
  return hashLogId(logId) % shardCount;
}

/**
 * Get the DO instance name for a shard index.
 *
 * Used with DurableObjectNamespace.idFromName() to get the DO stub.
 *
 * @param index - Shard index
 * @returns DO instance name, e.g. "shard-0", "shard-1"
 */
export function shardNameForIndex(index: number): string {
  return `shard-${index}`;
}

/**
 * Get the DO instance name for a logId.
 *
 * Convenience function combining shardIndexForLog and shardNameForIndex.
 *
 * @param logId - Log identifier (UUID string)
 * @param shardCount - Total number of shards
 * @returns DO instance name
 */
export function shardNameForLog(logId: string, shardCount: number): string {
  return shardNameForIndex(shardIndexForLog(logId, shardCount));
}
