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
import { encodePayerAddressToExtra1 } from "./scrapi/payer-address";
import { verifyPayment } from "./scrapi/x402-facilitator";
import {
  X402_HEADERS,
  buildPaymentRequiredHeader,
  parsePaymentHeader,
  getPaymentRequirementsForVerify,
} from "./scrapi/x402";
import type { SettlementJob, AuthState } from "@canopy/x402-settlement-types";
import { hashLogId } from "@canopy/forestrie-sharding";

export type X402Mode = "verify-only" | "verify-and-settle";

/**
 * Auth info response from X402SettlementDO.getAuthInfo().
 */
interface AuthInfo {
  state: AuthState;
  failureCount: number;
}

/**
 * Generate a 403 Forbidden response for blocked payment authorizations.
 *
 * Uses RFC 9457 Problem Details format with actionable resolution info.
 */
function authBlockedResponse(
  authId: string,
  failureCount: number,
  corsHeaders: Record<string, string>,
): Response {
  const problem = {
    type: "https://forestrie.dev/problems/x402/auth-blocked",
    title: "Payment Authorization Blocked",
    status: 403,
    detail:
      "Your payment authorization has been blocked due to repeated settlement failures. " +
      "This typically occurs when insufficient funds are available at settlement time.",
    authId,
    failureCount,
    resolution: {
      action: "top_up_and_request_reset",
      description:
        "Ensure your wallet has sufficient USDC balance to cover pending settlements, " +
        "then contact support to reset your authorization.",
      supportUrl: "https://forestrie.dev/support/payment-block",
    },
  };

  const headers = new Headers({
    "Content-Type": "application/problem+json",
  });
  Object.entries(corsHeaders).forEach(([k, v]) => headers.set(k, v));

  return new Response(JSON.stringify(problem), {
    status: 403,
    statusText: "Forbidden",
    headers,
  });
}

export interface Env {
  // Merklelog storage bucket (massifs + checkpoints) written by Arbor services.
  // Keys:
  // - v2/merklelog/massifs/{massifHeight}/{logId}/{massifIndex}.log
  // - v2/merklelog/checkpoints/{massifHeight}/{logId}/{massifIndex}.sth
  R2_MMRS: R2Bucket;
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
          //
          // x402 payment flow:
          // - If no X-PAYMENT header, return 402 with X-PAYMENT-REQUIRED
          //   describing the exact scheme payment option.
          // - If present, parse and validate the EIP-3009 payment payload.
          // - In verify-and-settle mode, call the facilitator to verify.
          const paymentHeader = request.headers.get(
            X402_HEADERS.paymentSignature,
          );

          const resourceUrl = `${url.origin}/logs/${segments[1]}/entries`;
          const x402Config = {
            network: x402Network,
            payTo: x402PayTo,
            priceAtomic: env.X402_PRICE_ATOMIC,
          };

          console.log("x402 dev config", {
            mode: x402Mode,
            facilitatorUrlDefined: !!x402FacilitatorUrl,
            network: x402Config.network,
            payTo: x402Config.payTo,
            hasQueue: !!env.X402_SETTLEMENT_QUEUE,
          });

          if (!paymentHeader) {
            const base = problemResponse(
              402,
              "Payment Required",
              "about:blank",
              {
                detail:
                  "x402 payment required for statement registration at this endpoint",
              },
            );

            const headers = new Headers(base.headers);
            Object.entries(corsHeaders).forEach(([k, v]) => headers.set(k, v));
            headers.set(
              X402_HEADERS.paymentRequired,
              buildPaymentRequiredHeader(resourceUrl, x402Config),
            );

            return new Response(base.body, {
              status: 402,
              statusText: "Payment Required",
              headers,
            });
          }

          const parsed = parsePaymentHeader(paymentHeader, x402Config);
          if (!parsed.ok) {
            const base = problemResponse(400, "Bad Request", "about:blank", {
              detail: `Invalid x402 payment header: ${parsed.error}`,
            });

            const headers = new Headers(base.headers);
            Object.entries(corsHeaders).forEach(([k, v]) => headers.set(k, v));

            return new Response(base.body, {
              status: 400,
              statusText: "Bad Request",
              headers,
            });
          }

          // Check if the payer's auth is blocked before calling CDP verify.
          // This saves a CDP round-trip and provides immediate feedback.
          if (x402Mode === "verify-and-settle" && env.X402_SETTLEMENT_DO) {
            const authId = `local:${parsed.value.payerAddress}`;
            const shardCount = parseInt(env.X402_DO_SHARD_COUNT ?? "4", 10);
            const shardIndex = hashLogId(authId) % shardCount;
            const shardName = `shard-${shardIndex}`;

            try {
              const doId = env.X402_SETTLEMENT_DO.idFromName(shardName);
              const stub = env.X402_SETTLEMENT_DO.get(doId) as unknown as {
                getAuthInfo(authId: string): Promise<AuthInfo | null>;
              };
              const authInfo = await stub.getAuthInfo(authId);

              if (authInfo?.state === "blocked") {
                console.log("Auth blocked, rejecting request", {
                  authId,
                  failureCount: authInfo.failureCount,
                });

                return authBlockedResponse(
                  authId,
                  authInfo.failureCount,
                  corsHeaders,
                );
              }
            } catch (err) {
              // If DO lookup fails, log and continue - don't block the request
              // The settlement worker will catch blocked auths anyway
              console.warn("Auth state lookup failed, continuing", {
                error: err instanceof Error ? err.message : String(err),
              });
            }
          }

          // In verify-and-settle mode, call the facilitator to verify
          // the payment before proceeding.
          let authResult: { authId: string } | undefined;
          if (x402Mode === "verify-and-settle" && parsed.ok) {
            const requirements = getPaymentRequirementsForVerify(
              resourceUrl,
              x402Config,
            );
            const verifyResult = await verifyPayment(
              parsed.value,
              requirements,
              x402Mode,
              {
                facilitatorUrl: x402FacilitatorUrl,
                verifyTimeoutMs: 5000,
                cdpCredentials:
                  env.CDP_API_KEY_ID && env.CDP_API_KEY_SECRET
                    ? {
                        keyId: env.CDP_API_KEY_ID,
                        keySecret: env.CDP_API_KEY_SECRET,
                      }
                    : undefined,
              },
            );

            console.log("x402 verify result", {
              ok: verifyResult.ok,
              // authId is an opaque identifier, safe to log for debugging
              authId: verifyResult.ok ? verifyResult.authId : undefined,
              mode: x402Mode,
            });

            if (!verifyResult.ok) {
              console.error("x402 verify failed", {
                mode: x402Mode,
                error: verifyResult.error,
              });

              const base = problemResponse(
                402,
                "Payment Required",
                "about:blank",
                {
                  detail: `x402 verification failed: ${verifyResult.error}`,
                },
              );

              const headers = new Headers(base.headers);
              Object.entries(corsHeaders).forEach(([k, v]) =>
                headers.set(k, v),
              );
              headers.set(
                X402_HEADERS.paymentRequired,
                buildPaymentRequiredHeader(resourceUrl, x402Config),
              );

              return new Response(base.body, {
                status: 402,
                statusText: "Payment Required",
                headers,
              });
            }

            authResult = { authId: verifyResult.authId };
          }

          let enqueueExtras: Parameters<
            import("@canopy/forestrie-ingress-types").SequencingQueueStub["enqueue"]
          >[2];

          if (parsed.ok && "payerAddress" in parsed.value) {
            try {
              const encoded = encodePayerAddressToExtra1(
                (parsed.value as any).payerAddress as string,
              );
              enqueueExtras = { extra1: encoded.slice().buffer };
            } catch (e) {
              console.warn(
                "Failed to encode payer address into extra1, continuing without extras:",
                e instanceof Error ? e.message : e,
              );
            }
          }

          const response = await registerSignedStatement(
            request,
            segments[1],
            env.SEQUENCING_QUEUE,
            env.QUEUE_SHARD_COUNT,
            enqueueExtras,
          );

          // Emit settlement job after successful registration (303 response)
          // Extract content hash from Location header for idempotency key
          console.log("Settlement job emission check", {
            responseStatus: response.status,
            x402Mode,
            hasAuthResult: !!authResult,
            parsedOk: parsed.ok,
            hasQueue: !!env.X402_SETTLEMENT_QUEUE,
          });

          if (
            response.status === 303 &&
            x402Mode === "verify-and-settle" &&
            authResult &&
            parsed.ok &&
            env.X402_SETTLEMENT_QUEUE
          ) {
            const location = response.headers.get("Location");
            const contentHash = location?.split("/").pop();

            console.log("Creating settlement job", {
              location,
              contentHash,
              authId: authResult.authId,
            });

            if (contentHash) {
              const job: SettlementJob = {
                jobId: crypto.randomUUID(),
                authId: authResult.authId,
                scheme: "exact",
                payer: parsed.value.payerAddress,
                amount: parsed.value.amount,
                logId: segments[1],
                contentHash,
                idempotencyKey: `${authResult.authId}:${contentHash}:${segments[1]}`,
                createdAt: Date.now(),
                // Store the full payload for settlement
                payload: parsed.value.payload,
              };

              console.log("Sending settlement job to queue", {
                jobId: job.jobId,
                idempotencyKey: job.idempotencyKey,
              });

              // Fire-and-forget: don't block the response on queue send
              ctx.waitUntil(
                env.X402_SETTLEMENT_QUEUE.send(job)
                  .then(() => {
                    console.log("Settlement job sent successfully", {
                      jobId: job.jobId,
                    });
                  })
                  .catch((err) => {
                    console.error("Failed to send settlement job:", err);
                  }),
              );
            }
          }

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
