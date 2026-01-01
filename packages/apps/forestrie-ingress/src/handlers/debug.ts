/**
 * Handler for GET /queue/debug/recent
 *
 * Returns recent entries with timestamps for latency analysis.
 * Aggregates entries from all shards.
 */

import type { Env } from "../env.js";
import { internalError, getQueueStub, getShardCount } from "./handler.js";

/**
 * Handle GET /queue/debug/recent
 *
 * Query params:
 * - limit: max entries to return per shard (default 100)
 * - shard: optional specific shard to query (default: all shards)
 *
 * Response: JSON array of recent entries with timestamps and latency metrics
 */
export async function handleDebugRecent(
  request: Request,
  env: Env,
): Promise<Response> {
  try {
    const url = new URL(request.url);
    const limit = parseInt(url.searchParams.get("limit") || "100", 10);
    const shardParam = url.searchParams.get("shard");
    const shardCount = getShardCount(env);

    // Recent entry type from recentEntries()
    type RecentEntry = {
      seq: number;
      logId: string;
      contentHash: string;
      enqueuedAt: number;
      ackedAt: number | null;
      leafIndex: number | null;
      massifIndex: number | null;
    };

    // Collect entries from specified shard or all shards
    let entries: RecentEntry[] = [];

    if (shardParam !== null) {
      const shardIndex = parseInt(shardParam, 10);
      if (isNaN(shardIndex) || shardIndex < 0 || shardIndex >= shardCount) {
        return Response.json(
          { error: `shard must be in range [0, ${shardCount - 1}]` },
          { status: 400 },
        );
      }
      const stub = getQueueStub(env, shardIndex);
      entries = await stub.recentEntries(limit);
    } else {
      // Aggregate from all shards
      const perShardLimit = Math.ceil(limit / shardCount);
      for (let i = 0; i < shardCount; i++) {
        const stub = getQueueStub(env, i);
        const shardEntries = await stub.recentEntries(perShardLimit);
        entries.push(...shardEntries);
      }
      // Sort by seq descending and limit
      entries.sort((a, b) => b.seq - a.seq);
      entries = entries.slice(0, limit);
    }

    // Add computed fields for analysis
    const now = Date.now();
    const enriched = entries.map((e) => ({
      ...e,
      ageMs: now - e.enqueuedAt,
      sequenced: e.leafIndex !== null,
      // Sequencing latency: time from enqueue to ack (null if not yet acked)
      sequencingLatencyMs: e.ackedAt !== null ? e.ackedAt - e.enqueuedAt : null,
    }));

    // Compute summary stats for sequenced entries
    const sequenced = enriched.filter((e) => e.sequencingLatencyMs !== null);
    const latencies = sequenced.map((e) => e.sequencingLatencyMs as number);
    const summary =
      latencies.length > 0
        ? {
            count: latencies.length,
            minMs: Math.min(...latencies),
            maxMs: Math.max(...latencies),
            avgMs: Math.round(
              latencies.reduce((a, b) => a + b, 0) / latencies.length,
            ),
            p50Ms: percentile(latencies, 50),
            p95Ms: percentile(latencies, 95),
            p99Ms: percentile(latencies, 99),
          }
        : null;

    return Response.json({
      timestamp: now,
      count: enriched.length,
      latencySummary: summary,
      entries: enriched,
    });
  } catch (error) {
    return internalError(error);
  }
}

function percentile(sorted: number[], p: number): number {
  const arr = [...sorted].sort((a, b) => a - b);
  const idx = Math.ceil((p / 100) * arr.length) - 1;
  return arr[Math.max(0, idx)];
}
