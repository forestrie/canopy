/**
 * Canopy API - Native Cloudflare Workers Implementation
 *
 * Minimal SCRAPI-compatible API without SvelteKit
 */

import { problemResponse } from "./scrapi/cbor-response";
import { registerSignedStatement } from "./scrapi/register-signed-statement";
import { queryRegistrationStatus } from "./scrapi/query-registration-status";
import { resolveReceipt } from "./scrapi/resolve-receipt";
import { getTransparencyConfiguration } from "./scrapi/transparency-configuration";
import { deleteExpiredLeaves } from "./cf/r2";

export interface Env {
  R2_LEAVES: R2Bucket;
  // Merklelog storage bucket (massifs + checkpoints) written by Arbor services.
  // Keys:
  // - v2/merklelog/massifs/{massifHeight}/{logId}/{massifIndex}.log
  // - v2/merklelog/checkpoints/{massifHeight}/{logId}/{massifIndex}.sth
  R2_MMRS: R2Bucket;
  // Receipt resolution cache (written by Forester, read by canopy-api).
  // Keys: ranger/v1/{logId}/latest/{contentHashHex} -> v1 JSON value.
  RANGER_MMR_INDEX: KVNamespace;
  CANOPY_ID: string;
  FOREST_PROJECT_ID: string;
  API_VERSION: string;
  NODE_ENV: string;
  /**
   * TTL for transient ingress leaves in R2, in seconds.
   *
   * Note: this is enforced by a scheduled cleanup sweep, not by native R2 lifecycle rules.
   */
  LEAF_TTL_SECONDS: string;
}

function getLeafTtlSeconds(env: Env): number {
  const ttl = Number.parseInt(env.LEAF_TTL_SECONDS || "", 10);
  return Number.isFinite(ttl) && ttl > 0 ? ttl : 0;
}

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<Response> {
    const url = new URL(request.url);
    const { pathname } = url;

    // CORS headers for development
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    };

    // Handle OPTIONS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: corsHeaders,
      });
    }

    try {
      // Health check
      if (pathname === "/api/health" && request.method === "GET") {
        return Response.json(
          {
            status: "healthy",
            canopyId: env.CANOPY_ID,
            forestProjectId: env.FOREST_PROJECT_ID,
            apiVersion: env.API_VERSION,
          },
          { headers: corsHeaders },
        );
      }

      // SCITT configuration
      if (
        pathname === "/.well-known/scitt-configuration" &&
        request.method === "GET"
      ) {
        const config = getTransparencyConfiguration(env.CANOPY_ID, url.origin, {
          name: "Canopy Transparency Service",
          description: "SCITT-compliant transparency log",
          contact: "admin@example.com",
        });
        return Response.json(config, {
          status: 200,
          headers: corsHeaders,
        });
      }

      // note the first segment is the empty string due to leading '/'
      const segments = pathname.split("/").slice(1);

      if (segments[0] !== "logs") {
        return problemResponse(
          404,
          "Not Found",
          `The requested resource ${pathname} was not found`,
          corsHeaders,
        );
      }

      // Route group 1: /logs/{logId}/entries...
      if (segments.length >= 3 && segments[2] === "entries") {
        if (request.method === "POST") {
          // POST /logs/{logId}/entries - Register new statement
          // R2_LEAVES event notifications will automatically send messages to the queue
          const response = await registerSignedStatement(
            request,
            segments[1],
            env.R2_LEAVES,
          );

          const headers = new Headers(response.headers);
          Object.entries(corsHeaders).forEach(([k, v]) => headers.set(k, v));

          return new Response(response.body, {
            status: response.status,
            statusText: response.statusText,
            headers,
          });
        }

        if (request.method !== "GET") {
          return problemResponse(
            405,
            "Method Not Allowed",
            `The requested resource ${pathname} does not support method ${request.method}`,
            corsHeaders,
          );
        }

        // GET /logs/{logId}/entries/{contentHash} - Query registration status
        if (segments.length === 4) {
          const response = await queryRegistrationStatus(
            request,
            segments.slice(1),
            env.RANGER_MMR_INDEX,
          );

          const headers = new Headers(response.headers);
          Object.entries(corsHeaders).forEach(([k, v]) => headers.set(k, v));

          return new Response(response.body, {
            status: response.status,
            statusText: response.statusText,
            headers,
          });
        }

        return problemResponse(
          404,
          "Not Found",
          `The requested resource ${pathname} was not found`,
          corsHeaders,
        );
      }

      // Route group 2: /logs/{logId}/{massifHeight}/entries/{entryId}/receipt
      if (segments.length >= 4 && segments[3] === "entries") {
        if (request.method !== "GET") {
          return problemResponse(
            405,
            "Method Not Allowed",
            `The requested resource ${pathname} does not support method ${request.method}`,
            corsHeaders,
          );
        }

        const response = await resolveReceipt(
          request,
          segments.slice(1),
          env.R2_MMRS,
        );

        const headers = new Headers(response.headers);
        Object.entries(corsHeaders).forEach(([k, v]) => headers.set(k, v));

        return new Response(response.body, {
          status: response.status,
          statusText: response.statusText,
          headers,
        });
      }

      return problemResponse(
        404,
        "Not Found",
        `The requested resource ${pathname} was not found`,
        corsHeaders,
      );
    } catch (error) {
      console.error("Unhandled error:", error);
      return problemResponse(
        500,
        "Internal Server Error",
        error instanceof Error ? error.message : "An unexpected error occurred",
        { headers: corsHeaders },
      );
    }
  },

  async scheduled(
    controller: ScheduledController,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<void> {
    const ttlSeconds = getLeafTtlSeconds(env);
    if (ttlSeconds <= 0) return;

    ctx.waitUntil(
      deleteExpiredLeaves(env.R2_LEAVES, ttlSeconds, {
        prefix: "logs/",
        // Keep the sweep lightweight; it will run again next minute.
        timeBudgetMs: 10_000,
      })
        .then(({ scanned, deleted, timedOut }) => {
          console.log(
            `[leaf-expiry] ttl=${ttlSeconds}s scanned=${scanned} deleted=${deleted} timedOut=${timedOut} cron=${controller.cron}`,
          );
        })
        .catch((error) => {
          console.error("[leaf-expiry] cleanup failed:", error);
        }),
    );
  },
};
