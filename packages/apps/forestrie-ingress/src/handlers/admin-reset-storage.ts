/**
 * POST /queue/admin/reset-storage — dev only; wipes a SequencingQueue shard.
 *
 * Query: shard=0|1|… or shard=all
 * Header: X-Forestrie-Ingress-Reset must equal secret INGRESS_RESET_TOKEN.
 */

import type { Env } from "../env.js";
import { PROBLEM_TYPES } from "@canopy/forestrie-ingress-types";
import {
  problemResponse,
  internalError,
  getQueueStub,
  getShardCount,
} from "./handler.js";

export async function handleAdminResetStorage(
  request: Request,
  url: URL,
  env: Env,
): Promise<Response> {
  if (env.NODE_ENV !== "dev") {
    return new Response("Not Found", { status: 404 });
  }

  const configured = env.INGRESS_RESET_TOKEN;
  if (!configured || configured.length < 16) {
    return problemResponse(
      503,
      PROBLEM_TYPES.INTERNAL_ERROR,
      "Reset unavailable",
      "INGRESS_RESET_TOKEN is not configured for this worker",
    );
  }

  const presented = request.headers.get("X-Forestrie-Ingress-Reset") ?? "";
  if (presented !== configured) {
    return problemResponse(
      401,
      PROBLEM_TYPES.INVALID_REQUEST,
      "Unauthorized",
      "Invalid or missing X-Forestrie-Ingress-Reset header",
    );
  }

  const shardParam = url.searchParams.get("shard");
  if (shardParam === null) {
    return problemResponse(
      400,
      PROBLEM_TYPES.INVALID_REQUEST,
      "Invalid request",
      "shard query parameter is required (integer or 'all')",
    );
  }

  const shardCount = getShardCount(env);

  try {
    const resetOne = async (shardIndex: number) => {
      const stub = getQueueStub(env, shardIndex);
      await stub.devResetStorage();
    };

    if (shardParam === "all") {
      for (let i = 0; i < shardCount; i++) {
        await resetOne(i);
      }
      return Response.json({
        ok: true,
        reset: "all",
        shardCount,
      });
    }

    const shardIndex = parseInt(shardParam, 10);
    if (isNaN(shardIndex) || shardIndex < 0 || shardIndex >= shardCount) {
      return problemResponse(
        400,
        PROBLEM_TYPES.INVALID_REQUEST,
        "Invalid request",
        `shard must be an integer in [0, ${shardCount - 1}] or 'all'`,
      );
    }

    await resetOne(shardIndex);
    return Response.json({ ok: true, reset: shardIndex });
  } catch (error) {
    return internalError(error);
  }
}
