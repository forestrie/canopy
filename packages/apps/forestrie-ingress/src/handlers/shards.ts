/**
 * Handler for GET /queue/shards
 *
 * Shard discovery endpoint for rangers.
 * Returns shard count, pull URL template, and per-shard pending counts.
 *
 * Response: JSON (observability endpoint)
 */

import type { Env } from "../env.js";
import { getShardCount, getQueueStub, internalError } from "./handler.js";

/**
 * Shard info for discovery response.
 */
interface ShardInfo {
  index: number;
  pendingCount: number;
}

/**
 * Shard discovery response.
 */
interface ShardsResponse {
  count: number;
  pullUrlTemplate: string;
  ackUrlTemplate: string;
  shards: ShardInfo[];
}

export async function handleShards(env: Env): Promise<Response> {
  try {
    const shardCount = getShardCount(env);

    // Query each shard for its pending count
    const shards: ShardInfo[] = [];
    for (let i = 0; i < shardCount; i++) {
      const stub = getQueueStub(env, i);
      const pendingCount = await stub.getPendingCount();
      shards.push({ index: i, pendingCount });
    }

    const response: ShardsResponse = {
      count: shardCount,
      pullUrlTemplate: "/queue/pull?shard={shard}",
      ackUrlTemplate: "/queue/ack?shard={shard}",
      shards,
    };

    return Response.json(response, {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (error) {
    return internalError(error);
  }
}
