/**
 * Ranger cache worker entrypoint.
 *
 * This worker uses a Durable Object per log to manage sequencing completion
 * notifications. Each object stores the most recently sequenced entries for
 * content hashes. The objects maintain a bounded cache with FIFO eviction.
 */
import type { Env } from "./env.js";
import type { RangerQueueBatch } from "./rangerqueue.js";
import { handleQueue } from "./queuehandler.js";
import { handleHealth } from "./healthhandler.js";

// Re-export Durable Object class (required by Wrangler)
export { SequencedContent } from "./durableobjects/index.js";

// Re-export Env type for external use
export type { Env } from "./env.js";

const worker = {
  async queue(
    batch: RangerQueueBatch,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<void> {
    await handleQueue(batch, env, ctx);
  },

  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/_ranger-cache/health") {
      return handleHealth(env);
    }

    return new Response("ranger-cache worker", {
      status: 200,
      headers: { "content-type": "text/plain" },
    });
  },
};

export default worker;
