/**
 * Canopy API - Native Cloudflare Workers Implementation
 *
 * Minimal SCRAPI-compatible API without SvelteKit
 */

import { checkRequestEnv } from "./env/deployment-env";
import { supportedChainsConfigForEnv } from "./env/supported-chains-for-env.js";
import {
  createReceiptAuthorityResolver,
  type ReceiptAuthorityResolver,
} from "./env/receipt-authority-resolver.js";
import { problemResponse } from "./cbor-api/cbor-response.js";
import { handleForestRequest } from "./forest/handle-forest-request.js";
import { handleOnboardingRequest } from "./onboarding/handle-onboarding-request.js";
import { handlePaymentsRequest } from "./payments/handle-payments-request.js";
import { registerGrant, type RegisterGrantEnv } from "./scrapi/register-grant";
import { createUnivocityGrantValidator } from "./scrapi/univocity-grant-client.js";
import { registerSignedStatement } from "./scrapi/register-signed-statement";
import { queryRegistrationStatus } from "./scrapi/query-registration-status";
import { resolveReceipt } from "./scrapi/resolve-receipt";
import { getTransparencyConfiguration } from "./scrapi/transparency-configuration";
import type { SettlementJob } from "@canopy/x402-settlement-types";

export type X402Mode = "verify-only" | "verify-and-settle";

export interface Env {
  // Merklelog storage bucket (massifs + checkpoints) written by Arbor services.
  // Keys:
  // - v2/merklelog/massifs/{massifHeight}/{logId}/{massifIndex}.log
  // - v2/merklelog/checkpoints/{massifHeight}/{logId}/{massifIndex}.sth
  R2_MMRS: R2Bucket;
  // Grants storage bucket (optional legacy / other uses). Forestrie-Grant v0 path when used:
  // grant/<sha256>.cbor (content-addressed). Register-grant does not require R2 (Plan 0008).
  R2_GRANTS: R2Bucket;
  // Public base URL if clients resolve grant paths under this bucket.
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
  /** Base URL of arbor Custodian (no trailing slash). */
  CUSTODIAN_URL?: string;
  /**
   * Trust-root read URL (defaults to CUSTODIAN_URL in pilot).
   * Future BYOK: Univocity trust-root service.
   */
  TRUST_ROOT_URL?: string;
  /** Maps to Custodian secret APP_TOKEN; curator/log-key + receipt verification. */
  CUSTODIAN_APP_TOKEN?: string;
  /** Delegation Coordinator base URL for BYOK public-root receipt verification. */
  DELEGATION_COORDINATOR_URL?: string;
  /** Delegation Coordinator bearer token for public-root receipt verification. */
  COORDINATOR_APP_TOKEN?: string;
  /**
   * Pool-test only: 128 hex chars = ES256 public x‖y (64 bytes) for receipt Sign1 verify
   * when Custodian is not used. Forbidden when NODE_ENV !== "test" (503).
   */
  FORESTRIE_RECEIPT_VERIFY_TEST_ES256_XY_HEX?: string;
  /** Bootstrap signing alg: ES256 (default) or KS256. */
  BOOTSTRAP_ALG?: string;
  /** Bearer secret for ops onboard-token mint/list/revoke (Wrangler secret). */
  CANOPY_OPS_ADMIN_TOKEN?: string;
  UNIVOCITY_SERVICE_URL?: string;
  /** Bearer token authorizing canopy -> univocity owned-store calls. */
  UNIVOCITY_API_TOKEN?: string;
  /** JSON map: chainId → preference-ordered RPC URLs (deploy-resolved). */
  SUPPORTED_CHAINS_RPC?: string;
  ONBOARD_REQUEST_TTL_SEC?: string;
  ONBOARD_REQUEST_WEBHOOK_URL?: string;
  ONBOARD_REQUEST_WEBHOOK_SECRET?: string;
  ONBOARD_AUTO_APPROVE?: string;
  ONBOARD_AUTO_APPROVE_CHAIN_IDS?: string;
  ONBOARD_AUTO_APPROVE_LABEL_PREFIX?: string;
  ONBOARD_TOKEN_TTL_SEC?: string;
  ONBOARD_GATE_CACHE_TTL_SEC?: string;
  ONBOARD_MAX_PENDING_PER_BINDING?: string;
  ONBOARD_RPC_TIMEOUT_MS?: string;
  ONBOARD_CREATE_RATE_LIMITER?: {
    limit(options: { key: string }): Promise<{ success: boolean }>;
  };
  /** Optional: base URL for checkpoint fetch (storage source when R2 not used). */
  OBJECT_STORAGE_ROOT_URL?: string;
}

function buildBootstrapEnvForRegisterGrant(
  env: Env,
  massifHeight: number,
  bootstrapLogId: string,
): RegisterGrantEnv["bootstrapEnv"] {
  return {
    bootstrapLogId,
    r2Grants: env.R2_GRANTS,
    r2Mmrs: env.R2_MMRS,
    massifHeight,
  };
}

let receiptAuthorityResolverCache:
  | { signature: string; resolver: ReceiptAuthorityResolver }
  | undefined;

function trustRootUrlForEnv(env: Env): string {
  const explicit = env.TRUST_ROOT_URL?.trim();
  if (explicit) return explicit;
  return env.CUSTODIAN_URL?.trim() ?? "";
}

function receiptAuthorityResolverForEnv(env: Env): ReceiptAuthorityResolver {
  const signature = [
    env.NODE_ENV,
    trustRootUrlForEnv(env),
    env.DELEGATION_COORDINATOR_URL?.trim() ?? "",
    env.COORDINATOR_APP_TOKEN?.trim() ?? "",
    env.UNIVOCITY_SERVICE_URL?.trim() ?? "",
    env.UNIVOCITY_API_TOKEN?.trim() ?? "",
    env.FORESTRIE_RECEIPT_VERIFY_TEST_ES256_XY_HEX ?? "",
    env.SUPPORTED_CHAINS_RPC?.trim() ?? "",
  ].join("\0");
  if (
    !receiptAuthorityResolverCache ||
    receiptAuthorityResolverCache.signature !== signature
  ) {
    receiptAuthorityResolverCache = {
      signature,
      resolver: createReceiptAuthorityResolver({
        trustRootUrl: trustRootUrlForEnv(env),
        coordinatorTrustRootUrl: env.DELEGATION_COORDINATOR_URL,
        coordinatorToken: env.COORDINATOR_APP_TOKEN,
        univocityTrustRootUrl: env.UNIVOCITY_SERVICE_URL,
        univocityToken: env.UNIVOCITY_API_TOKEN,
        nodeEnv: env.NODE_ENV,
        testReceiptVerifyEs256XyHex:
          env.FORESTRIE_RECEIPT_VERIFY_TEST_ES256_XY_HEX,
        supportedChains: supportedChainsConfigForEnv(env),
      }),
    };
  }
  return receiptAuthorityResolverCache.resolver;
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
      const misconfigured = checkRequestEnv(request, env, corsHeaders);
      if (misconfigured) {
        return misconfigured;
      }

      const onboardingResponse = await handleOnboardingRequest(
        request,
        pathname,
        env,
        corsHeaders,
        ctx,
      );
      if (onboardingResponse) {
        return onboardingResponse;
      }

      const paymentsResponse = await handlePaymentsRequest(
        request,
        pathname,
        env,
        corsHeaders,
      );
      if (paymentsResponse) {
        return paymentsResponse;
      }

      const forestResponse = await handleForestRequest(
        request,
        pathname,
        {
          ...env,
          resolveReceiptAuthority: receiptAuthorityResolverForEnv(env),
        },
        corsHeaders,
      );
      if (forestResponse) {
        return forestResponse;
      }

      const resolveReceiptAuthority = receiptAuthorityResolverForEnv(env);

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

      const massifHeight = parseInt(env.MASSIF_HEIGHT || "14", 10);
      const queueEnvForSequencing = env.SEQUENCING_QUEUE
        ? {
            sequencingQueue: env.SEQUENCING_QUEUE,
            shardCountStr: env.QUEUE_SHARD_COUNT,
          }
        : undefined;

      // POST /register/{bootstrap-logid}/grants | /register/{bootstrap-logid}/entries
      if (segments[0] === "register" && request.method === "POST") {
        if (segments.length === 3 && segments[2] === "grants" && segments[1]) {
          const bootstrapSeg = segments[1];
          const bootstrapEnvForGrant = buildBootstrapEnvForRegisterGrant(
            env,
            massifHeight,
            bootstrapSeg,
          );
          const univocityServiceUrl = env.UNIVOCITY_SERVICE_URL?.trim();
          const univocityApiToken = env.UNIVOCITY_API_TOKEN?.trim();
          const creationGrantValidator =
            univocityServiceUrl && univocityApiToken
              ? createUnivocityGrantValidator({
                  serviceUrl: univocityServiceUrl,
                  token: univocityApiToken,
                })
              : undefined;
          const response = await registerGrant(request, {
            queueEnv: queueEnvForSequencing,
            bootstrapEnv: bootstrapEnvForGrant,
            resolveReceiptAuthority,
            creationGrantValidator,
            nodeEnv: env.NODE_ENV,
          });
          const headers = new Headers(response.headers);
          Object.entries(corsHeaders).forEach(([k, v]) => headers.set(k, v));
          return new Response(response.body, {
            status: response.status,
            statusText: response.statusText,
            headers,
          });
        }
        if (segments.length === 3 && segments[2] === "entries" && segments[1]) {
          const response = await registerSignedStatement(
            request,
            env.SEQUENCING_QUEUE,
            env.QUEUE_SHARD_COUNT,
            undefined,
            resolveReceiptAuthority,
            env.NODE_ENV,
            segments[1],
            env.R2_GRANTS,
            env,
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

      if (segments[0] !== "logs") {
        return problemResponse(
          404,
          "Not Found",
          `The requested resource ${pathname} was not found`,
          corsHeaders,
        );
      }

      // Route group 1: /logs/{bootstrap}/{logId}/entries/{contentHash} (GET)
      if (segments.length === 5 && segments[3] === "entries") {
        if (request.method !== "GET") {
          return problemResponse(
            405,
            "Method Not Allowed",
            `The requested resource ${pathname} does not support method ${request.method}`,
            corsHeaders,
          );
        }

        const response = await queryRegistrationStatus(
          request,
          segments.slice(1),
          env.SEQUENCING_QUEUE as unknown as Parameters<
            typeof queryRegistrationStatus
          >[2],
          env.R2_MMRS,
          massifHeight,
          env.QUEUE_SHARD_COUNT,
          env.R2_GRANTS,
        );

        const headers = new Headers(response.headers);
        Object.entries(corsHeaders).forEach(([k, v]) => headers.set(k, v));

        return new Response(response.body, {
          status: response.status,
          statusText: response.statusText,
          headers,
        });
      }

      // Route group 2: /logs/{bootstrap}/{logId}/{massifHeight}/entries/{entryId}/receipt
      if (
        segments.length === 7 &&
        segments[4] === "entries" &&
        segments[6] === "receipt"
      ) {
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
          env.R2_GRANTS,
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
