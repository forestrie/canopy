/**
 * Handler for GET /queue/debug/recent
 *
 * Returns recent entries with timestamps for latency analysis.
 */

import type { Env } from "../env.js";
import { internalError, getQueueStub } from "./handler.js";

/**
 * Handle GET /queue/debug/recent
 *
 * Query params:
 * - limit: max entries to return (default 100)
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

    const stub = getQueueStub(env);
    const entries = await stub.recentEntries(limit);

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
