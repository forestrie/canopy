/**
 * Handler for GET /queue/stats
 *
 * Aggregates stats across all shards.
 */

import type { Env } from "../env.js";
import type { QueueStats } from "@canopy/forestrie-ingress-types";
import { internalError, getQueueStub, getShardCount } from "./handler.js";

/**
 * Aggregated stats response including per-shard breakdown.
 */
interface AggregatedStats extends QueueStats {
  shardCount: number;
  perShard: Array<{ index: number } & QueueStats>;
}

/**
 * Handle GET /queue/stats
 *
 * Response: JSON aggregated QueueStats
 */
export async function handleStats(
  _request: Request,
  env: Env,
): Promise<Response> {
  try {
    const shardCount = getShardCount(env);

    // Collect stats from all shards
    const perShard: Array<{ index: number } & QueueStats> = [];
    let totalPending = 0;
    let totalDeadLetters = 0;
    let oldestEntryAgeMs: number | null = null;
    let totalActivePollers = 0;
    let anyPollerLimitReached = false;

    for (let i = 0; i < shardCount; i++) {
      const stub = getQueueStub(env, i);
      const stats = await stub.stats();
      perShard.push({ index: i, ...stats });

      totalPending += stats.pending;
      totalDeadLetters += stats.deadLetters;
      totalActivePollers += stats.activePollers;
      anyPollerLimitReached = anyPollerLimitReached || stats.pollerLimitReached;

      if (stats.oldestEntryAgeMs !== null) {
        if (oldestEntryAgeMs === null || stats.oldestEntryAgeMs > oldestEntryAgeMs) {
          oldestEntryAgeMs = stats.oldestEntryAgeMs;
        }
      }
    }

    const aggregated: AggregatedStats = {
      pending: totalPending,
      deadLetters: totalDeadLetters,
      oldestEntryAgeMs,
      activePollers: totalActivePollers,
      pollerLimitReached: anyPollerLimitReached,
      shardCount,
      perShard,
    };

    return Response.json(aggregated);
  } catch (error) {
    return internalError(error);
  }
}
