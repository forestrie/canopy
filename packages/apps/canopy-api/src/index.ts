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
import { verifyAuthorizationForRegister } from "./scrapi/x402-facilitator";
import {
  X402_HEADERS,
  buildPaymentRequiredForRegister,
  parsePaymentSignatureHeader,
} from "./scrapi/x402";

export type X402Mode = "verify-only" | "verify-and-settle";

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
  X402_PRICE_EXACT?: string;
  X402_PRICE_UPTO_MAX?: string;
  // Massif height for this transparency log (1-based, typically 14)
  MASSIF_HEIGHT: string;
  // Number of DO shards for the sequencing queue (typically 4)
  QUEUE_SHARD_COUNT: string;
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
          // Yolo x402 phase:
          // - If no Payment-Signature header, return 402 with Payment-Required
          //   describing exact/upto options.
          // - If present, syntactically validate the header and, if valid,
          //   proceed to registerSignedStatement.
          const paymentHeader = request.headers.get(
            X402_HEADERS.paymentSignature,
          );

          // For now, both modes share the same verification behaviour.
          // In Phase 2b, "verify-and-settle" will additionally contact a
          // facilitator to settle funds after successful verification.

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
              buildPaymentRequiredForRegister(segments[1]),
            );

            return new Response(base.body, {
              status: 402,
              statusText: "Payment Required",
              headers,
            });
          }

          const parsed = parsePaymentSignatureHeader(paymentHeader);
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

          // In verify-and-settle mode, perform an additional synchronous
          // authorization check via the facilitator client. For now this is
          // a stub that always succeeds, but the wiring ensures that
          // failures in a future Phase 2b cut can return 402 before we
          // enqueue.
          if (x402Mode === "verify-and-settle" && parsed.ok) {
            const auth = await verifyAuthorizationForRegister(
              parsed.value,
              x402Mode,
              {
                facilitatorUrl: x402FacilitatorUrl,
                network: x402Network,
                payTo: x402PayTo,
                verifyTimeoutMs: 2000,
              },
            );

            if (!auth.ok) {
              const base = problemResponse(
                402,
                "Payment Required",
                "about:blank",
                {
                  detail: `x402 authorization failed: ${auth.error}`,
                },
              );

              const headers = new Headers(base.headers);
              Object.entries(corsHeaders).forEach(([k, v]) =>
                headers.set(k, v),
              );
              headers.set(
                X402_HEADERS.paymentRequired,
                buildPaymentRequiredForRegister(segments[1]),
              );

              return new Response(base.body, {
                status: 402,
                statusText: "Payment Required",
                headers,
              });
            }
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
