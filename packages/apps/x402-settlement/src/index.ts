/**
 * x402-settlement worker
 *
 * Consumes settlement jobs from a Cloudflare Queue and processes them via
 * the X402SettlementDO Durable Object. Each job represents a charge to be
 * settled against an x402 authorization.
 *
 * See: devdocs/arc/arc-0015-x402-settlement-architecture.md
 */

import type { SettlementJob } from "@canopy/x402-settlement-types";
import { hashLogId } from "@canopy/forestrie-sharding";
import { checkBearer } from "@canopy/ops-bearer";
import { isUnivocityInstanceId } from "@canopy/univocity-instance-id";
import { X402SettlementDO } from "./durableobjects/x402settlement.js";
import { ReceivablesDO } from "./durableobjects/receivables.js";
import { generateCdpJwt, facilitatorRequiresAuth } from "./cdp-jwt.js";
import { runCheckpointIndexer } from "./indexer/run-indexer.js";
import { readRegisteredAccount } from "./indexer/instance-accounts.js";
import type { Env } from "./env.js";

export { X402SettlementDO };
export { ReceivablesDO };

/**
 * Resolve the DO shard name for an authId.
 *
 * Uses djb2 hash (same as forestrie-sharding) for consistent distribution.
 */
function resolveShardId(authId: string, shardCount: number): string {
  const hash = hashLogId(authId);
  const index = hash % shardCount;
  return `shard-${index}`;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * Ops gate for `/admin/**` — the same operator identity as canopy-api's
 * `/api/payments/**` (CANOPY_OPS_ADMIN_TOKEN, pushed as a wrangler secret).
 * Closes the previously unauthenticated reset-auth (ARC-0026 finding).
 */
function adminBearerOrUnauthorized(
  request: Request,
  env: Env,
): Response | null {
  const outcome = checkBearer(
    request,
    env.CANOPY_OPS_ADMIN_TOKEN?.trim() ?? "",
  );
  if (outcome === "ok") return null;
  return jsonResponse(
    {
      error:
        outcome === "missing"
          ? "Authorization: Bearer <CANOPY_OPS_ADMIN_TOKEN> required"
          : "Invalid ops admin token",
    },
    401,
  );
}

export default {
  /**
   * Queue consumer handler.
   *
   * Processes settlement jobs from the queue, routing each to the appropriate
   * DO shard for idempotent processing.
   */
  async queue(
    batch: MessageBatch<SettlementJob>,
    env: Env,
    _ctx: ExecutionContext,
  ): Promise<void> {
    const shardCount = parseInt(env.DO_SHARD_COUNT, 10) || 4;

    for (const message of batch.messages) {
      const job = message.body;

      // Validate job structure
      if (!job.authId || !job.idempotencyKey) {
        console.error("Invalid settlement job, missing required fields", {
          jobId: job.jobId,
        });
        message.ack(); // Don't retry invalid messages
        continue;
      }

      // Route to appropriate DO shard
      const shardId = resolveShardId(job.authId, shardCount);
      const doId = env.X402_SETTLEMENT_DO.idFromName(shardId);
      const stub = env.X402_SETTLEMENT_DO.get(doId);

      try {
        const result = await stub.processJob(job);

        if (result.ok) {
          console.log("Settlement succeeded", {
            jobId: job.jobId,
            txHash: result.txHash,
          });
          // Credits land only after on-chain settlement (slice 04). Failure
          // to credit RETRIES the message — processJob is idempotent (cached
          // settled result), so redelivery converges on the credit landing.
          if (job.kind === "credits") {
            try {
              await creditSettledPurchase(env, job, result.txHash);
            } catch (err) {
              console.error(
                "Settled credits purchase failed to credit; retrying",
                {
                  jobId: job.jobId,
                  idempotencyKey: job.idempotencyKey,
                  error: err instanceof Error ? err.message : String(err),
                },
              );
              message.retry();
              continue;
            }
          }
        } else {
          // Settlement failed - DO has recorded the failure and updated auth state.
          // We always ack to avoid DLQ; auth blocking provides visibility.
          console.error("Settlement failed", {
            jobId: job.jobId,
            error: result.error,
            permanent: result.permanent,
          });
        }
        // Always ack - failure tracking is handled by DO's auth_state table
        message.ack();
      } catch (err) {
        // DO RPC error - log and ack to avoid DLQ buildup.
        // This is rare and indicates infrastructure issues rather than
        // payment problems. Auth state won't be updated but that's acceptable
        // for transient DO failures.
        console.error("Settlement DO RPC error", {
          jobId: job.jobId,
          error: err instanceof Error ? err.message : String(err),
        });
        message.ack();
      }
    }
  },

  /**
   * HTTP handler for health checks and x402 facilitator endpoints.
   *
   * This worker acts as a facilitator for canopy-api, proxying verify/settle
   * requests to the upstream CDP x402 API with our credentials.
   */
  async fetch(
    request: Request,
    env: Env,
    _ctx: ExecutionContext,
  ): Promise<Response> {
    const url = new URL(request.url);

    // Health check
    if (url.pathname === "/health") {
      return new Response(
        JSON.stringify({
          status: "ok",
          canopyId: env.CANOPY_ID,
          env: env.NODE_ENV,
          hasCdpCredentials: !!(env.CDP_API_KEY_ID && env.CDP_API_KEY_SECRET),
        }),
        {
          headers: { "Content-Type": "application/json" },
        },
      );
    }

    // x402 facilitator /verify endpoint
    if (url.pathname === "/verify" && request.method === "POST") {
      return handleVerify(request, env);
    }

    // x402 facilitator /settle endpoint
    if (url.pathname === "/settle" && request.method === "POST") {
      return handleSettle(request, env);
    }

    // Admin: reset auth state (for recovery from blocked state)
    if (url.pathname === "/admin/reset-auth" && request.method === "POST") {
      const authErr = adminBearerOrUnauthorized(request, env);
      if (authErr) return authErr;
      return handleResetAuth(request, env);
    }

    // Admin: watermark-set tool (plan-2607-03 R2 residual — the recorded
    // arming gate): move a stalled account's cursor forward past a poisoned
    // range without a deploy. Forward-only; the DO rejects rewinds.
    const watermarkMatch = /^\/admin\/receivables\/([^/]+)\/watermark$/.exec(
      url.pathname,
    );
    if (watermarkMatch && request.method === "PUT") {
      const authErr = adminBearerOrUnauthorized(request, env);
      if (authErr) return authErr;
      const id = decodeURIComponent(watermarkMatch[1]!);
      if (!isUnivocityInstanceId(id)) {
        return jsonResponse(
          { error: "path id must be a canonical univocity instance id" },
          400,
        );
      }
      let body: {
        chainId?: unknown;
        univocityAddr?: unknown;
        lastBlock?: unknown;
      };
      try {
        body = (await request.json()) as typeof body;
      } catch {
        return jsonResponse({ error: "invalid JSON body" }, 400);
      }
      if (
        typeof body.chainId !== "string" ||
        typeof body.univocityAddr !== "string" ||
        typeof body.lastBlock !== "number"
      ) {
        return jsonResponse(
          { error: "body requires chainId, univocityAddr, lastBlock" },
          400,
        );
      }
      const stub = env.RECEIVABLES_DO.get(env.RECEIVABLES_DO.idFromName(id));
      try {
        const result = await stub.setWatermark(
          id,
          body.chainId,
          body.univocityAddr,
          body.lastBlock,
        );
        return jsonResponse({
          univocityInstanceId: id,
          lastBlock: result.lastBlock,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes("forward-only")) {
          return jsonResponse({ error: msg }, 409);
        }
        if (msg.includes("no account bound")) {
          return jsonResponse({ error: msg }, 404);
        }
        return jsonResponse({ error: msg }, 400);
      }
    }

    // Admin: receivables status read — the observe-only soak's observability
    // (plan-2607-43 slice 03): entitlement + the source watermark.
    const receivablesMatch = /^\/admin\/receivables\/([^/]+)$/.exec(
      url.pathname,
    );
    if (receivablesMatch && request.method === "GET") {
      const authErr = adminBearerOrUnauthorized(request, env);
      if (authErr) return authErr;
      const id = decodeURIComponent(receivablesMatch[1]!);
      if (!isUnivocityInstanceId(id)) {
        return jsonResponse(
          { error: "path id must be a canonical univocity instance id" },
          400,
        );
      }
      const stub = env.RECEIVABLES_DO.get(env.RECEIVABLES_DO.idFromName(id));
      const state = await stub.getIndexState(id);
      if (!state.entitlement && state.lastBlock === null) {
        return jsonResponse({ error: "no account state for instance" }, 404);
      }
      return jsonResponse({
        univocityInstanceId: id,
        entitlement: state.entitlement,
        watermarkBlock: state.lastBlock,
      });
    }

    return new Response("Not Found", { status: 404 });
  },

  /**
   * Cron: the accrual indexer sweep (plan-2607-43 slice 03, observe-only).
   */
  async scheduled(
    _controller: ScheduledController,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<void> {
    ctx.waitUntil(runCheckpointIndexer(env));
  },
};

/**
 * Credit a settled `kind="credits"` job to its ReceivablesDO account
 * (plan-2607-43 slice 04). The AccountRef is rebuilt from the reservation
 * registry — the root is not trusted from the job. Throws on any failure so
 * the queue message retries; `recordPayment` is idempotent on the job's
 * idempotencyKey, so redelivery cannot double-credit.
 */
async function creditSettledPurchase(
  env: Env,
  job: SettlementJob,
  txHash: string | undefined,
): Promise<void> {
  const id = job.univocityInstanceId;
  const credits = job.credits;
  if (!id || !isUnivocityInstanceId(id)) {
    throw new Error(
      `credits job ${job.jobId} has no valid univocityInstanceId`,
    );
  }
  if (!Number.isInteger(credits) || (credits as number) < 1) {
    throw new Error(`credits job ${job.jobId} has no valid credits count`);
  }
  if (!env.R2_GRANTS) {
    throw new Error("R2_GRANTS binding absent; cannot resolve account");
  }
  const account = await readRegisteredAccount(env.R2_GRANTS, id);
  if (!account) {
    throw new Error(`no registered account for ${id}`);
  }
  const stub = env.RECEIVABLES_DO.get(env.RECEIVABLES_DO.idFromName(id));
  const entitlement = await stub.recordPayment(
    account,
    job.idempotencyKey,
    credits as number,
    txHash ?? null,
  );
  console.log("Credits landed", {
    univocityInstanceId: id,
    credits,
    balance: entitlement.creditsBalance,
    arrears: entitlement.arrears,
  });
}

/**
 * Proxy /verify requests to upstream CDP x402 API.
 */
async function handleVerify(request: Request, env: Env): Promise<Response> {
  const needsAuth = facilitatorRequiresAuth(env.X402_FACILITATOR_URL);
  if (needsAuth && (!env.CDP_API_KEY_ID || !env.CDP_API_KEY_SECRET)) {
    console.error("CDP credentials not configured");
    return Response.json(
      { isValid: false, invalidReason: "facilitator not configured" },
      { status: 500 },
    );
  }

  const body = await request.text();

  // Log the full body for debugging schema issues
  console.log("x402-settlement /verify proxy", {
    upstreamUrl: `${env.X402_FACILITATOR_URL}/verify`,
    bodyLength: body.length,
    bodyPreview: body.slice(0, 1000),
    authenticated: needsAuth,
  });

  try {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (needsAuth) {
      const jwt = await generateCdpJwt(
        env.CDP_API_KEY_ID!,
        env.CDP_API_KEY_SECRET!,
        `POST ${new URL(env.X402_FACILITATOR_URL).host}/platform/v2/x402/verify`,
      );
      headers["Authorization"] = `Bearer ${jwt}`;
    }

    const res = await fetch(`${env.X402_FACILITATOR_URL}/verify`, {
      method: "POST",
      headers,
      body,
    });

    const responseText = await res.text();
    console.log("CDP /verify response", {
      status: res.status,
      body: responseText.slice(0, 500),
    });

    return new Response(responseText, {
      status: res.status,
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("CDP /verify error", err);
    return Response.json(
      {
        isValid: false,
        invalidReason: `upstream error: ${err instanceof Error ? err.message : String(err)}`,
      },
      { status: 502 },
    );
  }
}

/**
 * Proxy /settle requests to upstream CDP x402 API.
 */
async function handleSettle(request: Request, env: Env): Promise<Response> {
  const needsAuth = facilitatorRequiresAuth(env.X402_FACILITATOR_URL);
  if (needsAuth && (!env.CDP_API_KEY_ID || !env.CDP_API_KEY_SECRET)) {
    console.error("CDP credentials not configured");
    return Response.json(
      { success: false, error: "facilitator not configured" },
      { status: 500 },
    );
  }

  const body = await request.text();

  console.log("x402-settlement /settle proxy", {
    upstreamUrl: `${env.X402_FACILITATOR_URL}/settle`,
    bodyLength: body.length,
    authenticated: needsAuth,
  });

  try {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (needsAuth) {
      const jwt = await generateCdpJwt(
        env.CDP_API_KEY_ID!,
        env.CDP_API_KEY_SECRET!,
        `POST ${new URL(env.X402_FACILITATOR_URL).host}/platform/v2/x402/settle`,
      );
      headers["Authorization"] = `Bearer ${jwt}`;
    }

    const res = await fetch(`${env.X402_FACILITATOR_URL}/settle`, {
      method: "POST",
      headers,
      body,
    });

    const responseText = await res.text();
    console.log("CDP /settle response", {
      status: res.status,
      body: responseText.slice(0, 500),
    });

    return new Response(responseText, {
      status: res.status,
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("CDP /settle error", err);
    return Response.json(
      {
        success: false,
        error: `upstream error: ${err instanceof Error ? err.message : String(err)}`,
      },
      { status: 502 },
    );
  }
}

/**
 * Admin endpoint to reset auth state (for recovery from blocked state).
 */
async function handleResetAuth(request: Request, env: Env): Promise<Response> {
  try {
    const body = (await request.json()) as { authId?: string };
    if (!body.authId) {
      return Response.json({ error: "authId required" }, { status: 400 });
    }

    const shardCount = parseInt(env.DO_SHARD_COUNT, 10) || 4;
    const shardId = resolveShardId(body.authId, shardCount);
    const doId = env.X402_SETTLEMENT_DO.idFromName(shardId);
    const stub = env.X402_SETTLEMENT_DO.get(doId);

    const result = await stub.resetAuth(body.authId);

    return Response.json({
      success: true,
      authId: body.authId,
      previous: result.previous,
    });
  } catch (err) {
    console.error("Reset auth error", err);
    return Response.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
