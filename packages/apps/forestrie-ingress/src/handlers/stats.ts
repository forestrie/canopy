/**
 * Handler for GET /queue/stats
 */

import type { Env } from "../env.js";
import { internalError, getQueueStub } from "./handler.js";

/**
 * Handle GET /queue/stats
 *
 * Response: JSON QueueStats
 */
export async function handleStats(
  _request: Request,
  env: Env,
): Promise<Response> {
  try {
    const stub = getQueueStub(env);
    const stats = await stub.stats();

    return Response.json(stats);
  } catch (error) {
    return internalError(error);
  }
}
