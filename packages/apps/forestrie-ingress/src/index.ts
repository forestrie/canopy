/**
 * forestrie-ingress Worker
 *
 * Owns the SequencingQueue Durable Object for ingress processing.
 * The DO is consumed by canopy-api via cross-worker DO RPC binding.
 */

import type { Env } from "./env.js";

// Export Durable Objects for Cloudflare runtime
export { SequencingQueue } from "./durableobjects/index.js";

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<Response> {
    const url = new URL(request.url);

    // Health check
    if (url.pathname === "/_forestrie-ingress/health") {
      return Response.json({
        status: "ok",
        canopyId: env.CANOPY_ID,
      });
    }

    // Default response
    return new Response("forestrie-ingress worker", { status: 200 });
  },
};
