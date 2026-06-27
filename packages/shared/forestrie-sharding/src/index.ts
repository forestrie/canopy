/**
 * @canopy/forestrie-sharding — logId → SequencingQueue shard helpers.
 * Re-exports {@link shardNameForLog} and related functions from `./sharding.js`.
 */

export {
  hashLogId,
  shardIndexForLog,
  shardNameForIndex,
  shardNameForLog,
} from "./sharding.js";
