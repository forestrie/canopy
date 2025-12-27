/**
 * Health check endpoint handler.
 */
import type { Env } from "./env.js";

/**
 * Handle health check requests.
 *
 * @param env - Worker environment bindings
 * @returns JSON response with health status
 */
export function handleHealth(env: Env): Response {
  return Response.json({
    status: "ok",
    canopyId: env.CANOPY_ID,
    env: env.NODE_ENV,
  });
}
