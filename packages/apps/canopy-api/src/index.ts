/**
 * Canopy API - Native Cloudflare Workers Implementation
 *
 * Minimal SCRAPI-compatible API without SvelteKit
 */

import { problemResponse } from "./scrapi/cbor-response";
import {
  handlePostBootstrapGrant,
  serveBootstrapGrant,
} from "./scrapi/bootstrap-grant.js";
import { registerGrant } from "./scrapi/register-grant";
import { registerSignedStatement } from "./scrapi/register-signed-statement";
import { queryRegistrationStatus } from "./scrapi/query-registration-status";
import { resolveReceipt } from "./scrapi/resolve-receipt";
import { serveGrant } from "./scrapi/serve-grant";
import { getTransparencyConfiguration } from "./scrapi/transparency-configuration";
import type { SettlementJob } from "@canopy/x402-settlement-types";

export type X402Mode = "verify-only" | "verify-and-settle";

export interface Env {
  // Merklelog storage bucket (massifs + checkpoints) written by Arbor services.
  // Keys:
  // - v2/merklelog/massifs/{massifHeight}/{logId}/{massifIndex}.log
  // - v2/merklelog/checkpoints/{massifHeight}/{logId}/{massifIndex}.sth
  R2_MMRS: R2Bucket;
  // Grants storage bucket (content-addressable grant objects).
  // Path format: <kind>/<hash>.cbor. Location returned to clients is path-only, relative to GRANT_STORAGE_PUBLIC_BASE.
  R2_GRANTS: R2Bucket;
  // Public base URL for grant storage (path-only location is relative to this).
  GRANT_STORAGE_PUBLIC_BASE?: string;
  // Durable Object namespace for the ingress sequencing queue.
  // Sharded by logId hash. Owned by forestrie-ingress worker.
  // Used for both enqueue (register-signed-statement) and resolveContent (query-registration-status).
  SEQUENCING_QUEUE: DurableObjectNamespace;
  CANOPY_ID: string;
  FOREST_PROJECT_ID: string;
  API_VERSION: string;
  NODE_ENV: string;
  // x402 operation mode. "verify-only" performs cryptographic verification
  // without contacting a facilitator or settling funds. "verify-and-settle"
  // (Phase 2b) will verify and charge via an x402 facilitator.
  X402_MODE?: X402Mode;
  // x402 facilitator configuration. In dev this typically points to
  // https://x402.org/facilitator on Base Sepolia; in prod it points to
  // the CDP facilitator on Base mainnet.
  X402_FACILITATOR_URL?: string;
  X402_NETWORK?: string;
  X402_PAYTO_ADDRESS?: string;
  X402_PRICE_ATOMIC?: string;
  // Massif height for this transparency log (1-based, typically 14)
  MASSIF_HEIGHT: string;
  // Number of DO shards for the sequencing queue (typically 4)
  QUEUE_SHARD_COUNT: string;
  // Queue producer for x402 settlement jobs (Phase 2b)
  // Optional binding - only present when queue is provisioned
  X402_SETTLEMENT_QUEUE?: Queue<SettlementJob>;
  // CDP API credentials for direct x402 verification (Wrangler secrets)
  CDP_API_KEY_ID?: string;
  CDP_API_KEY_SECRET?: string;
  // X402 settlement DO for auth state lookups (cross-worker binding)
  // Note: Uses untyped namespace since RPC types aren't exported across workers
  X402_SETTLEMENT_DO?: DurableObjectNamespace;
  // Number of DO shards for x402 settlement (typically 4)
  X402_DO_SHARD_COUNT?: string;
  // Subplan 08: grant-first bootstrap
  ROOT_LOG_ID?: string;
  DELEGATION_SIGNER_URL?: string;
  DELEGATION_SIGNER_BEARER_TOKEN?: string;
  DELEGATION_SIGNER_PUBLIC_KEY_TOKEN?: string;
  UNIVOCITY_SERVICE_URL?: string;
  UNIVOCITY_CONTRACT_RPC_URL?: string;
  UNIVOCITY_CONTRACT_ADDRESS?: string;
  /** Optional: base URL for checkpoint fetch (storage source when R2 not used). */
  OBJECT_STORAGE_ROOT_URL?: string;
}

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<Response> {
    const url = new URL(request.url);
    const { pathname } = url;
    const segments = pathname.split("/").slice(1);

    // CORS headers for development
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers":
        "Content-Type, Authorization, X-Grant-Location",
    };

    // Handle OPTIONS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: corsHeaders,
      });
    }

    try {
      const x402Mode: X402Mode = env.X402_MODE ?? "verify-only";
      const x402FacilitatorUrl = env.X402_FACILITATOR_URL;
      const x402Network = env.X402_NETWORK;
      const x402PayTo = env.X402_PAYTO_ADDRESS;

      // Misconfiguration guard: verify-and-settle mode requires a facilitator
      // URL. Treat this as a hard 500 rather than silently falling back to
      // verify-only semantics.
      if (x402Mode === "verify-and-settle" && !x402FacilitatorUrl) {
        return problemResponse(500, "Internal Server Error", "about:blank", {
          detail:
            "x402 verify-and-settle mode requires X402_FACILITATOR_URL to be configured",
          headers: corsHeaders,
        });
      }

      // Subplan 08: POST /api/grants/bootstrap (no auth)
      if (
        pathname === "/api/grants/bootstrap" &&
        request.method === "POST"
      ) {
        const rootLogId = env.ROOT_LOG_ID;
        const delegationSignerUrl = env.DELEGATION_SIGNER_URL;
        const token = env.DELEGATION_SIGNER_BEARER_TOKEN;
        if (!rootLogId || !delegationSignerUrl || !token) {
          return problemResponse(
            503,
            "Service Unavailable",
            "about:blank",
            {
              detail:
                "Bootstrap grant mint not configured (ROOT_LOG_ID, DELEGATION_SIGNER_URL, DELEGATION_SIGNER_BEARER_TOKEN required)",
              headers: corsHeaders,
            },
          );
        }
        const response = await handlePostBootstrapGrant(request, {
          r2Grants: env.R2_GRANTS,
          rootLogId,
          delegationSignerUrl,
          delegationSignerBearerToken: token,
        });
        const headers = new Headers(response.headers);
        Object.entries(corsHeaders).forEach(([k, v]) => headers.set(k, v));
        return new Response(response.body, {
          status: response.status,
          statusText: response.statusText,
          headers,
        });
      }

      // GET /grants/bootstrap or /grants/bootstrap/:rootLogId — well-known bootstrap grant
      if (
        segments[0] === "grants" &&
        segments[1] === "bootstrap" &&
        request.method === "GET"
      ) {
        const rootLogId =
          segments[2] ?? env.ROOT_LOG_ID ?? "";
        if (!rootLogId) {
          return problemResponse(
            400,
            "Bad Request",
            "about:blank",
            { detail: "rootLogId required (path or ROOT_LOG_ID)", headers: corsHeaders },
          );
        }
        const response = await serveBootstrapGrant(rootLogId, {
          r2Grants: env.R2_GRANTS,
        });
        const headers = new Headers(response.headers);
        Object.entries(corsHeaders).forEach(([k, v]) => headers.set(k, v));
        return new Response(response.body, {
          status: response.status,
          statusText: response.statusText,
          headers,
        });
      }

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

      // GET /grants/authority/{innerHex} — serve grant with lazy completion (subplan 03)
      if (
        segments.length === 3 &&
        segments[0] === "grants" &&
        segments[1] === "authority" &&
        request.method === "GET"
      ) {
        const massifHeight = parseInt(env.MASSIF_HEIGHT || "14", 10);
        const response = await serveGrant(segments[2]!, {
          r2Grants: env.R2_GRANTS,
          r2Mmrs: env.R2_MMRS,
          sequencingQueue: env.SEQUENCING_QUEUE,
          shardCountStr: env.QUEUE_SHARD_COUNT,
          massifHeight,
        });
        const headers = new Headers(response.headers);
        Object.entries(corsHeaders).forEach(([k, v]) => headers.set(k, v));
        return new Response(response.body, {
          status: response.status,
          statusText: response.statusText,
          headers,
        });
      }

      if (segments[0] !== "logs") {
        return problemResponse(
          404,
          "Not Found",
          `The requested resource ${pathname} was not found`,
          corsHeaders,
        );
      }

      // POST /logs/{logId}/grants — create grant (Plan 0001 Step 6, subplan 03/08)
      if (
        segments.length === 3 &&
        segments[2] === "grants" &&
        request.method === "POST"
      ) {
        const bootstrapEnv =
          env.ROOT_LOG_ID &&
          env.DELEGATION_SIGNER_URL &&
          env.DELEGATION_SIGNER_BEARER_TOKEN &&
          env.UNIVOCITY_SERVICE_URL
            ? {
                rootLogId: env.ROOT_LOG_ID,
                delegationSignerUrl: env.DELEGATION_SIGNER_URL,
                delegationSignerBearerToken: env.DELEGATION_SIGNER_BEARER_TOKEN,
                delegationSignerPublicKeyToken:
                  env.DELEGATION_SIGNER_PUBLIC_KEY_TOKEN,
                univocityServiceUrl: env.UNIVOCITY_SERVICE_URL,
              }
            : undefined;
        const queueEnv =
          env.SEQUENCING_QUEUE
            ? {
                sequencingQueue: env.SEQUENCING_QUEUE,
                shardCountStr: env.QUEUE_SHARD_COUNT,
              }
            : undefined;
        const response = await registerGrant(request, segments[1], {
          r2Grants: env.R2_GRANTS,
          queueEnv,
          bootstrapEnv,
        });
        const headers = new Headers(response.headers);
        Object.entries(corsHeaders).forEach(([k, v]) => headers.set(k, v));
        return new Response(response.body, {
          status: response.status,
          statusText: response.statusText,
          headers,
        });
      }

      // Route group 1: /logs/{logId}/entries...
      if (segments.length >= 3 && segments[2] === "entries") {
        if (request.method === "POST") {
          // POST /logs/{logId}/entries - Register new statement
          // Grant-based auth is required (Step 5); x402 payment removed (Plan 0001 Step 4).
          const inclusionEnv =
            env.SEQUENCING_QUEUE
              ? {
                  sequencingQueue: env.SEQUENCING_QUEUE,
                  shardCountStr: env.QUEUE_SHARD_COUNT,
                }
              : undefined;
          const response = await registerSignedStatement(
            request,
            segments[1],
            env.SEQUENCING_QUEUE,
            env.QUEUE_SHARD_COUNT,
            undefined,
            env.R2_GRANTS,
            inclusionEnv,
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
          const massifHeight = parseInt(env.MASSIF_HEIGHT || "14", 10);
          const response = await queryRegistrationStatus(
            request,
            segments.slice(1),
            // Type assertion: the DO binding provides SequencingQueueStub methods via RPC
            env.SEQUENCING_QUEUE as unknown as Parameters<
              typeof queryRegistrationStatus
            >[2],
            env.R2_MMRS,
            massifHeight,
            env.QUEUE_SHARD_COUNT,
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
};
