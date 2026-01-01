/**
 * Common handler utilities for forestrie-ingress HTTP endpoints.
 *
 * Non-observability endpoints (pull, ack) use CBOR exclusively.
 * Observability endpoints (stats) use JSON.
 */

import { decode } from "cbor-x";
import type { Env } from "../env.js";
import {
  PROBLEM_TYPES,
  PROBLEM_CONTENT_TYPE,
} from "@canopy/forestrie-ingress-types";
import { shardNameForIndex } from "@canopy/forestrie-sharding";

const CBOR_CONTENT_TYPE = "application/cbor";

/**
 * Create a Problem Details error response (RFC 9457).
 */
export function problemResponse(
  status: number,
  type: string,
  title: string,
  detail?: string,
): Response {
  return new Response(
    JSON.stringify({
      type,
      title,
      status,
      detail,
    }),
    {
      status,
      headers: { "Content-Type": PROBLEM_CONTENT_TYPE },
    },
  );
}

/**
 * Create a standard internal error response.
 */
export function internalError(error: unknown): Response {
  console.error("Internal error:", error);
  return problemResponse(
    500,
    PROBLEM_TYPES.INTERNAL_ERROR,
    "Internal error",
    error instanceof Error ? error.message : "Unknown error",
  );
}

/**
 * Parse shard count from environment string.
 */
export function getShardCount(env: Env): number {
  const count = parseInt(env.QUEUE_SHARD_COUNT, 10);
  if (isNaN(count) || count < 1) {
    console.error(
      `Invalid QUEUE_SHARD_COUNT: ${env.QUEUE_SHARD_COUNT}, using 1`,
    );
    return 1;
  }
  return count;
}

/**
 * Get the DO stub for a specific shard.
 */
export function getQueueStub(env: Env, shardIndex: number) {
  const shardName = shardNameForIndex(shardIndex);
  const id = env.SEQUENCING_QUEUE.idFromName(shardName);
  return env.SEQUENCING_QUEUE.get(id);
}

/**
 * Parse CBOR request body, returning 415 if content type is not application/cbor.
 */
export async function parseCborBody<T>(
  request: Request,
): Promise<T | Response> {
  const contentType = request.headers.get("Content-Type") ?? "";

  if (!contentType.includes(CBOR_CONTENT_TYPE)) {
    return problemResponse(
      415,
      PROBLEM_TYPES.INVALID_REQUEST,
      "Unsupported Media Type",
      "Content-Type must be application/cbor",
    );
  }

  const buffer = await request.arrayBuffer();
  return decode(new Uint8Array(buffer)) as T;
}
