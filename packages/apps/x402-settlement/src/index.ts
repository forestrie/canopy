/**
 * x402-settlement worker
 *
 * Consumes settlement jobs from a Cloudflare Queue and processes them via
 * the X402SettlementDO Durable Object. Each job represents a charge to be
 * settled against an x402 authorization.
 *
 * See: devdocs/arc/arc-0015-x402-settlement-architecture.md
 */

import type { SettlementJob } from "@canopy/x402-settlement-types";
import { hashLogId } from "@canopy/forestrie-sharding";
import { X402SettlementDO } from "./durableobjects/x402settlement.js";
import type { Env } from "./env.js";

export { X402SettlementDO };

/**
 * Resolve the DO shard name for an authId.
 *
 * Uses djb2 hash (same as forestrie-sharding) for consistent distribution.
 */
function resolveShardId(authId: string, shardCount: number): string {
  const hash = hashLogId(authId);
  const index = hash % shardCount;
  return `shard-${index}`;
}

export default {
  /**
   * Queue consumer handler.
   *
   * Processes settlement jobs from the queue, routing each to the appropriate
   * DO shard for idempotent processing.
   */
  async queue(
    batch: MessageBatch<SettlementJob>,
    env: Env,
    _ctx: ExecutionContext,
  ): Promise<void> {
    const shardCount = parseInt(env.DO_SHARD_COUNT, 10) || 4;

    for (const message of batch.messages) {
      const job = message.body;

      // Validate job structure
      if (!job.authId || !job.idempotencyKey) {
        console.error("Invalid settlement job, missing required fields", {
          jobId: job.jobId,
        });
        message.ack(); // Don't retry invalid messages
        continue;
      }

      // Route to appropriate DO shard
      const shardId = resolveShardId(job.authId, shardCount);
      const doId = env.X402_SETTLEMENT_DO.idFromName(shardId);
      const stub = env.X402_SETTLEMENT_DO.get(doId);

      try {
        const result = await stub.processJob(job);

        if (result.ok) {
          console.log("Settlement succeeded", {
            jobId: job.jobId,
            txHash: result.txHash,
          });
          message.ack();
        } else if (result.permanent) {
          // Permanent error - don't retry, let it go to DLQ
          console.error("Settlement failed permanently", {
            jobId: job.jobId,
            error: result.error,
          });
          message.ack();
        } else {
          // Transient error - retry via queue
          console.warn("Settlement failed transiently, will retry", {
            jobId: job.jobId,
            error: result.error,
          });
          message.retry();
        }
      } catch (err) {
        // Unexpected error in DO - retry
        console.error("Settlement DO error", {
          jobId: job.jobId,
          error: err instanceof Error ? err.message : String(err),
        });
        message.retry();
      }
    }
  },

  /**
   * HTTP handler for health checks and debugging.
   */
  async fetch(
    request: Request,
    env: Env,
    _ctx: ExecutionContext,
  ): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return new Response(
        JSON.stringify({
          status: "ok",
          canopyId: env.CANOPY_ID,
          env: env.NODE_ENV,
        }),
        {
          headers: { "Content-Type": "application/json" },
        },
      );
    }

    return new Response("Not Found", { status: 404 });
  },
};
