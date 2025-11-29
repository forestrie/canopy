/**
 * Ranger cache worker entrypoint.
 *
 * This worker consumes queue notifications that reference changed R2_LEAVES
 * objects, reads those objects, and updates KV-backed caches used by
 * the rest of the system.
 */

import type { RangerR2Bucket } from "./r2";
import type { RangerKVBindings, RangerKVNamespace } from "./kv";
import { toR2ObjectReference } from "./r2";
import { processR2ObjectNotification } from "./ranger";

// Minimal execution context surface we rely on.
interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
}

export interface Env {
  R2_LEAVES: RangerR2Bucket;
  RANGER_MMR_INDEX: RangerKVNamespace;
  RANGER_MMR_MASSIFS: RangerKVNamespace;
  CANOPY_ID: string;
  FOREST_PROJECT_ID: string;
  NODE_ENV: string;
}

function kvBindingsFromEnv(env: Env): RangerKVBindings {
  return {
    mmrIndexKV: env.RANGER_MMR_INDEX,
    mmrCacheKV: env.RANGER_MMR_MASSIFS,
  };
}

// Minimal queue event modelling. The full shape is provided by Cloudflare
// at runtime; we only model what we actually use.
export interface RangerQueueMessage {
  body: unknown;
}

export interface RangerQueueBatch {
  messages: RangerQueueMessage[];
}

const worker = {
  async queue(batch: RangerQueueBatch, env: Env, ctx: ExecutionContext) {
    const deps = {
      r2: env.R2_LEAVES,
      kv: kvBindingsFromEnv(env),
    };

    for (const message of batch.messages) {
      const ref = toR2ObjectReference(message.body);
      if (!ref) continue;

      ctx.waitUntil(processR2ObjectNotification(ref, deps));
    }
  },

  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/_ranger-cache/health") {
      return Response.json({
        status: "ok",
        canopyId: env.CANOPY_ID,
        env: env.NODE_ENV,
      });
    }

    return new Response("ranger-cache worker", {
      status: 200,
      headers: { "content-type": "text/plain" },
    });
  },
};

export default worker;
