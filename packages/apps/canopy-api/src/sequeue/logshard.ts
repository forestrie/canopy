/**
 * Single responsibility: resolve the sharded SequencingQueue Durable Object for a log.
 * All canopy code that talks to the queue by logId should use these helpers instead of
 * duplicating shardNameForLog + idFromName + get.
 *
 * See docs/plans/plan-0004-log-bootstraping/subplan-03-grant-sequencing-component.md
 */

import type { SequencingQueueStub } from "@canopy/forestrie-ingress-types";
import { shardNameForLog } from "@canopy/forestrie-sharding";

/** Minimal namespace shape: idFromName + get. Accepts DurableObjectNamespace or custom interfaces. */
export interface LogShardNamespace {
  idFromName(name: string): DurableObjectId;
  get(id: DurableObjectId): unknown;
}

/** Minimal env needed to resolve queue by logId. */
export interface LogShardEnv {
  sequencingQueue: LogShardNamespace;
  shardCountStr: string;
}

function parseShardCount(shardCountStr: string): number {
  const count = parseInt(shardCountStr, 10);
  if (Number.isNaN(count) || count < 1) return 1;
  return count;
}

/**
 * Return the Durable Object ID for the SequencingQueue shard that owns the given log.
 * Deterministic: same logId + env always yields the same DoId (same as enqueue/resolveContent use).
 */
export function getQueueIdForLog(
  env: LogShardEnv,
  logId: string,
): DurableObjectId {
  const shardCount = parseShardCount(env.shardCountStr);
  const shardName = shardNameForLog(logId, shardCount);
  return env.sequencingQueue.idFromName(shardName);
}

/**
 * Return the SequencingQueue stub for the shard that owns the given log.
 * Convenience wrapper around getQueueIdForLog + env.sequencingQueue.get(doId).
 */
export function getQueueForLog(
  env: LogShardEnv,
  logId: string,
): SequencingQueueStub {
  const doId = getQueueIdForLog(env, logId);
  return env.sequencingQueue.get(doId) as unknown as SequencingQueueStub;
}
