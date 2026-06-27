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
import type { Env } from "./env/worker-env.js";
import type { X402Mode } from "./env/x402-mode.js";

export type { X402Mode } from "./env/x402-mode.js";
export type { Env } from "./env/worker-env.js";

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
