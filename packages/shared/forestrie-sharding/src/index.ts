/**
 * @canopy/forestrie-sharding
 *
 * Sharding helpers for SequencingQueue Durable Object.
 * Provides deterministic shard assignment based on logId.
 */

export {
  hashLogId,
  shardIndexForLog,
  shardNameForIndex,
  shardNameForLog,
} from "./sharding.js";
