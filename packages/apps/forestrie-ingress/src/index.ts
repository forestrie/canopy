/**
 * forestrie-ingress Worker
 *
 * Owns the SequencingQueue Durable Object for ingress processing.
 * The DO is consumed by canopy-api via cross-worker DO RPC binding.
 * Rangers access the queue via HTTP endpoints.
 */

import type { Env } from "./env.js";
import {
  handlePull,
  handleAck,
  handleStats,
  handleDebugRecent,
} from "./handlers/index.js";

// Export Durable Objects for Cloudflare runtime
export { SequencingQueue } from "./durableobjects/index.js";

export default {
  async fetch(
    request: Request,
    env: Env,
    _ctx: ExecutionContext,
  ): Promise<Response> {
    const url = new URL(request.url);
    const method = request.method;

    // Health check
    if (url.pathname === "/_forestrie-ingress/health") {
      return Response.json({
        status: "ok",
        canopyId: env.CANOPY_ID,
      });
    }

    // Queue endpoints (for ranger HTTP access)
    if (url.pathname === "/queue/pull" && method === "POST") {
      return handlePull(request, env);
    }
    if (url.pathname === "/queue/ack" && method === "POST") {
      return handleAck(request, env);
    }
    if (url.pathname === "/queue/stats" && method === "GET") {
      return handleStats(request, env);
    }
    if (url.pathname === "/queue/debug/recent" && method === "GET") {
      return handleDebugRecent(request, env);
    }

    // Method not allowed for queue endpoints
    if (url.pathname.startsWith("/queue/")) {
      return new Response("Method Not Allowed", { status: 405 });
    }

    // Default response
    return new Response("forestrie-ingress worker", { status: 200 });
  },
};
