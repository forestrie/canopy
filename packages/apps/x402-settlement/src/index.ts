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
import {
  listRegisteredAccounts,
  readRegisteredAccount,
} from "./indexer/instance-accounts.js";
import { logProblemResponse } from "@canopy/problem-log";
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

/**
 * POST /admin/reset-storage — dev lane only; wipes DO storage.
 *
 * Two independent targets, since this worker's two DO classes are keyed
 * differently (see receivables.ts): `shard=<index>|all` wipes
 * {@link X402SettlementDO} shard(s), and `instance=<univocityInstanceId>|all`
 * wipes {@link ReceivablesDO} (it is one instance per account, not sharded by
 * count, so `instance=all` — not `shard=all` — is its every-instance form).
 * `instance=all` enumerates {@link listRegisteredAccounts} against
 * `env.R2_GRANTS` (the same reservation registry the indexer reads) and
 * calls `devResetStorage()` on each. `?shard=all&instance=all` in one
 * request resets both DO classes — the single call the forest-1
 * content-reset runbook (forestrie/forest-1#37) needs, since it cannot know
 * instance ids up front.
 *
 * CAVEAT: `instance=all` can only reset instances the reservation registry
 * still names. A ReceivablesDO can in principle exist (has been written to
 * by the indexer) for an instance whose `forests/index/chain-binding/{id}`
 * record was later deleted or expired, or that predates the registry, or
 * whose record's `state` is `reserved` rather than `registered`
 * ({@link listRegisteredAccounts} skips those, per its own doc) — such an
 * instance's ReceivablesDO is invisible to enumeration and `instance=all`
 * will not reset it. Only an explicit `instance=<id>` call resets a
 * ReceivablesDO with certainty.
 *
 * Query: `shard=0|1|…|all`, `instance=<univocityInstanceId>|all`, or both
 * together in one request.
 * Header: X-Forestrie-Settlement-Reset must equal SETTLEMENT_RESET_TOKEN.
 * Gated exactly like delegation-coordinator's `/admin/reset-storage`:
 * 404 unless NODE_ENV=dev or SETTLEMENT_RESET_ALLOWED=1; always token-gated.
 */
async function handleAdminResetStorage(
  request: Request,
  url: URL,
  env: Env,
): Promise<Response> {
  if (env.NODE_ENV !== "dev" && env.SETTLEMENT_RESET_ALLOWED !== "1") {
    return new Response("Not Found", { status: 404 });
  }

  const configured = env.SETTLEMENT_RESET_TOKEN;
  if (!configured || configured.length < 16) {
    return jsonResponse(
      { error: "SETTLEMENT_RESET_TOKEN is not configured for this worker" },
      503,
    );
  }

  const presented = request.headers.get("X-Forestrie-Settlement-Reset") ?? "";
  if (presented !== configured) {
    return jsonResponse(
      { error: "Invalid or missing X-Forestrie-Settlement-Reset header" },
      401,
    );
  }

  const instanceParam = url.searchParams.get("instance");
  const shardParam = url.searchParams.get("shard");

  if (instanceParam === null && shardParam === null) {
    return jsonResponse(
      {
        error:
          "shard query parameter (integer or 'all') or instance query parameter ('all' or a univocity instance id) is required",
      },
      400,
    );
  }

  // Validate both targets up front (no I/O side effects yet) so a request
  // combining shard and instance either resets both or neither — never a
  // partial reset because the second target turned out to be invalid.
  const shardCount = parseInt(env.DO_SHARD_COUNT, 10) || 4;
  let shardIndex: number | "all" | null = null;
  if (shardParam !== null) {
    if (shardParam === "all") {
      shardIndex = "all";
    } else {
      const idx = parseInt(shardParam, 10);
      if (isNaN(idx) || idx < 0 || idx >= shardCount) {
        return jsonResponse(
          {
            error: `shard must be an integer in [0, ${shardCount - 1}] or 'all'`,
          },
          400,
        );
      }
      shardIndex = idx;
    }
  }

  let instanceMode: "single" | "all" | null = null;
  if (instanceParam !== null) {
    if (instanceParam === "all") {
      if (!env.R2_GRANTS) {
        return jsonResponse(
          {
            error:
              "R2_GRANTS binding absent; cannot enumerate instances for instance=all",
          },
          503,
        );
      }
      instanceMode = "all";
    } else {
      if (!isUnivocityInstanceId(instanceParam)) {
        return jsonResponse(
          {
            error:
              "instance must be a canonical univocity instance id or 'all'",
          },
          400,
        );
      }
      instanceMode = "single";
    }
  }

  try {
    let shardResult:
      | { reset: "all"; shardCount: number }
      | { reset: number }
      | null = null;
    if (shardIndex !== null) {
      /** Reset one X402SettlementDO shard's SQLite via devResetStorage. */
      const resetOneShard = async (i: number) => {
        const stub = env.X402_SETTLEMENT_DO.get(
          env.X402_SETTLEMENT_DO.idFromName(`shard-${i}`),
        );
        await stub.devResetStorage();
      };
      if (shardIndex === "all") {
        for (let i = 0; i < shardCount; i++) {
          await resetOneShard(i);
        }
        shardResult = { reset: "all", shardCount };
      } else {
        await resetOneShard(shardIndex);
        shardResult = { reset: shardIndex };
      }
    }

    let instanceResult:
      | { reset: "instance"; instance: string }
      | { reset: "all-instances"; count: number; instances: string[] }
      | null = null;
    if (instanceMode === "all") {
      const accounts = await listRegisteredAccounts(env.R2_GRANTS!);
      const instanceIds = accounts.map((a) => a.univocityInstanceId);
      for (const id of instanceIds) {
        const stub = env.RECEIVABLES_DO.get(env.RECEIVABLES_DO.idFromName(id));
        await stub.devResetStorage();
      }
      instanceResult = {
        reset: "all-instances",
        count: instanceIds.length,
        instances: instanceIds,
      };
    } else if (instanceMode === "single") {
      const stub = env.RECEIVABLES_DO.get(
        env.RECEIVABLES_DO.idFromName(instanceParam!),
      );
      await stub.devResetStorage();
      instanceResult = { reset: "instance", instance: instanceParam! };
    }

    if (shardResult && instanceResult) {
      return jsonResponse({
        ok: true,
        shard: shardResult,
        instance: instanceResult,
      });
    }
    if (shardResult) {
      return jsonResponse({ ok: true, ...shardResult });
    }
    // instanceMode was non-null (the 400 above covers "neither given"), so
    // instanceResult is set here.
    return jsonResponse({ ok: true, ...instanceResult });
  } catch (err) {
    return jsonResponse(
      { error: err instanceof Error ? err.message : String(err) },
      500,
    );
  }
}

const handler = {
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
          // A settled `grant` purchase also credits the instance pool with its
          // revenue-equivalent (plan-2608-09 O2): the API sizes `credits` to the
          // paid amount so per-user grant revenue reconciles with the instance's
          // checkpoint economics. Sub-credit grants carry `credits: 0` and skip.
          if (shouldCreditPool(job)) {
            try {
              await creditSettledPurchase(env, job, result.txHash);
            } catch (err) {
              console.error(
                `Settled ${job.kind} purchase failed to credit; retrying`,
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

    // Admin: wipe DO storage (dev lane content-reset). Own gate — dev-only
    // or SETTLEMENT_RESET_ALLOWED, plus X-Forestrie-Settlement-Reset — not
    // the CANOPY_OPS_ADMIN_TOKEN bearer used by the routes above.
    if (url.pathname === "/admin/reset-storage" && request.method === "POST") {
      return handleAdminResetStorage(request, url, env);
    }

    // Admin: on-demand indexer sweep (plan-2607-06) — the metering canary's
    // deterministic nudge: removes the 5-min cron wait from its poll budget
    // and forces the top-up → unfreeze kill-switch reconcile. Same body as
    // the cron tick; safe to run concurrently with it (accrual is idempotent
    // and the watermark forward-only).
    if (url.pathname === "/admin/sweep" && request.method === "POST") {
      const authErr = adminBearerOrUnauthorized(request, env);
      if (authErr) return authErr;
      const summary = await runCheckpointIndexer(env);
      return jsonResponse(summary);
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
 * Every problem response leaves one structured log line (FOR-579): method,
 * route pattern, status, title, detail and `cf-ray`. The response is not
 * changed; the queue and cron handlers are exported as they are.
 */
export default {
  ...handler,
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<Response> {
    const response = await handler.fetch(request, env, ctx);
    return logProblemResponse(request, response, {
      service: "x402-settlement",
    });
  },
};

/**
 * Whether a settled job tops up its instance credits pool. `credits` purchases
 * always do; `grant` purchases do too (plan-2608-09 O2), sized to the revenue,
 * but a sub-credit grant carries `credits: 0` and is skipped (crediting 0 would
 * throw and wedge the message on retry).
 */
function shouldCreditPool(job: SettlementJob): boolean {
  if (job.kind === "credits") return true;
  if (job.kind === "grant") {
    return Number.isInteger(job.credits) && (job.credits ?? 0) >= 1;
  }
  return false;
}

/**
 * Credit a settled `credits`/`grant` job to its ReceivablesDO account
 * (plan-2607-43 slice 04; plan-2608-09 O2). The AccountRef is rebuilt from the
 * reservation registry — the root is not trusted from the job. Throws on any
 * failure so the queue message retries; `recordPayment` is idempotent on the
 * job's idempotencyKey, so redelivery cannot double-credit.
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
