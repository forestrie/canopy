/**
 * `/api/instances/{univocityInstanceId}/webhook` — instance-level webhook
 * registration and re-point (ADR-0005 amendment, FOR-468).
 *
 * The path segment is the canonical CAIP-10 univocity instance id
 * `eip155:{chainId}:0x{40 lowercase hex}` (ADR-0059 D1/D6); anything else is
 * rejected with 400.
 *
 * A univocity instance owner may operate many logs and hold custody of most of
 * their signing keys, so an instance-level webhook serves every log of that
 * instance. Inheritance is by **copy** into each log's config row, because that
 * row lives in a shard-addressed Durable Object keyed by log id: sibling logs
 * land in different shards, and a reference lookup would put a cross-shard hop
 * on the delegation request path, which is the primary path.
 *
 * The cost of copy is paid here. The instance record is replicated to every
 * shard (as delegate-key registration already is), and a PUT/DELETE fans out so
 * each shard both updates its replica and rewrites the copies its own member
 * logs hold. A rare fan-out write beats a hop on every request.
 *
 * Auth is the coordinator app token: an instance is not a log, so there is no
 * per-log issuer token to accept, and canopy brokers these calls exactly as it
 * brokers genesis registration.
 */

import { parseUnivocityInstanceId } from "@canopy/univocity-instance-id";
import type { Env } from "../env.js";
import { checkBearerToken } from "../auth/check-bearer-token.js";
import type {
  InstanceWebhookResponse,
  PutInstanceWebhookRequest,
} from "../types/instance-webhook.js";
import {
  WebhookUrlValidationError,
  validateWebhookUrl,
} from "../validate-webhook-url.js";
import {
  getShardCount,
  getStoreStub,
  internalError,
  problemResponse,
} from "./handler.js";

/** Parse a univocity instance id path segment or return a 400 problem. */
function parsePathUnivocityInstanceId(segment: string): string | Response {
  try {
    return parseUnivocityInstanceId(segment);
  } catch (error) {
    return problemResponse(
      400,
      "about:blank",
      "Invalid request",
      error instanceof Error ? error.message : "Invalid univocityInstanceId",
    );
  }
}

/** Fan a request out to every shard's instance-webhook route. */
async function fanOutToShards(
  env: Env,
  univocityInstanceId: string,
  init: RequestInit,
): Promise<{ responses: Response[]; shardCount: number }> {
  const shardCount = getShardCount(env);
  const path = `/instance-webhook/${encodeURIComponent(univocityInstanceId)}`;
  const responses = await Promise.all(
    Array.from({ length: shardCount }, (_, i) =>
      getStoreStub(env, i).fetch(`https://do.internal${path}`, init),
    ),
  );
  return { responses, shardCount };
}

/**
 * PUT /api/instances/{univocityInstanceId}/webhook — set or re-point.
 *
 * @returns `{ univocityInstanceId, webhookUrl, memberLogs, updatedLogs, shards }`.
 */
export async function handlePutInstanceWebhook(
  instanceIdSegment: string,
  request: Request,
  env: Env,
): Promise<Response> {
  try {
    const univocityInstanceId = parsePathUnivocityInstanceId(instanceIdSegment);
    if (univocityInstanceId instanceof Response) return univocityInstanceId;

    const authErr = checkBearerToken(request, env.COORDINATOR_APP_TOKEN);
    if (authErr) return authErr;

    const body = (await request.json()) as PutInstanceWebhookRequest;
    let validatedUrl: string;
    try {
      validatedUrl = validateWebhookUrl(body.url ?? "", {
        allowInsecureLocal: env.NODE_ENV === "dev",
      });
    } catch (error) {
      const detail =
        error instanceof WebhookUrlValidationError
          ? error.message
          : "Invalid webhook url";
      return problemResponse(400, "about:blank", "Invalid request", detail);
    }

    const { responses, shardCount } = await fanOutToShards(
      env,
      univocityInstanceId,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: validatedUrl }),
      },
    );

    // A shard rejecting rejects for all (same body, same id): surface it
    // verbatim. The re-point is idempotent, so a partial fan-out is repaired by
    // retrying the same PUT.
    let memberLogs = 0;
    let updatedLogs = 0;
    let createdAt: number | undefined;
    let updatedAt: number | undefined;
    for (const res of responses) {
      if (!res.ok) {
        return new Response(res.body, {
          status: res.status,
          headers: res.headers,
        });
      }
      const shardResult = (await res.json()) as InstanceWebhookResponse;
      memberLogs += shardResult.memberLogs ?? 0;
      updatedLogs += shardResult.updatedLogs ?? 0;
      createdAt = Math.min(createdAt ?? Infinity, shardResult.createdAt ?? 0);
      updatedAt = Math.max(updatedAt ?? 0, shardResult.updatedAt ?? 0);
    }

    const resp: InstanceWebhookResponse = {
      univocityInstanceId,
      // Legacy alias for one deploy cycle; dropped in plan-2607-43 slice 05.
      instanceKey: univocityInstanceId,
      webhookUrl: validatedUrl,
      memberLogs,
      updatedLogs,
      shards: shardCount,
    };
    if (createdAt !== undefined) resp.createdAt = createdAt;
    if (updatedAt !== undefined) resp.updatedAt = updatedAt;
    return Response.json(resp);
  } catch (error) {
    return internalError(error);
  }
}

/**
 * GET /api/instances/{univocityInstanceId}/webhook — read the instance webhook.
 *
 * @returns `{ univocityInstanceId, webhookUrl?, memberLogs }` or 404 when unknown.
 */
export async function handleGetInstanceWebhook(
  instanceIdSegment: string,
  request: Request,
  env: Env,
): Promise<Response> {
  try {
    const univocityInstanceId = parsePathUnivocityInstanceId(instanceIdSegment);
    if (univocityInstanceId instanceof Response) return univocityInstanceId;

    const authErr = checkBearerToken(request, env.COORDINATOR_APP_TOKEN);
    if (authErr) return authErr;

    const { responses } = await fanOutToShards(env, univocityInstanceId, {
      method: "GET",
    });

    let found = false;
    let memberLogs = 0;
    const resp: InstanceWebhookResponse = {
      univocityInstanceId,
      // Legacy alias for one deploy cycle; dropped in plan-2607-43 slice 05.
      instanceKey: univocityInstanceId,
    };
    for (const res of responses) {
      if (res.status === 404) continue;
      if (!res.ok) {
        return new Response(res.body, {
          status: res.status,
          headers: res.headers,
        });
      }
      found = true;
      const shardResult = (await res.json()) as InstanceWebhookResponse;
      memberLogs += shardResult.memberLogs ?? 0;
      if (shardResult.webhookUrl) {
        resp.webhookUrl = shardResult.webhookUrl;
        resp.createdAt = shardResult.createdAt;
        resp.updatedAt = shardResult.updatedAt;
      }
    }
    if (!found) {
      return problemResponse(404, "about:blank", "Not Found");
    }
    resp.memberLogs = memberLogs;
    return Response.json(resp);
  } catch (error) {
    return internalError(error);
  }
}

/**
 * DELETE /api/instances/{univocityInstanceId}/webhook — drop it everywhere.
 *
 * Member logs that inherited the URL revert to having none, i.e. pre-emptive
 * supply only — a supported configuration, not an error.
 */
export async function handleDeleteInstanceWebhook(
  instanceIdSegment: string,
  request: Request,
  env: Env,
): Promise<Response> {
  try {
    const univocityInstanceId = parsePathUnivocityInstanceId(instanceIdSegment);
    if (univocityInstanceId instanceof Response) return univocityInstanceId;

    const authErr = checkBearerToken(request, env.COORDINATOR_APP_TOKEN);
    if (authErr) return authErr;

    const { responses, shardCount } = await fanOutToShards(
      env,
      univocityInstanceId,
      { method: "DELETE" },
    );

    let updatedLogs = 0;
    for (const res of responses) {
      if (!res.ok) {
        return new Response(res.body, {
          status: res.status,
          headers: res.headers,
        });
      }
      const shardResult = (await res.json()) as InstanceWebhookResponse;
      updatedLogs += shardResult.updatedLogs ?? 0;
    }

    const resp: InstanceWebhookResponse = {
      univocityInstanceId,
      // Legacy alias for one deploy cycle; dropped in plan-2607-43 slice 05.
      instanceKey: univocityInstanceId,
      updatedLogs,
      shards: shardCount,
    };
    return Response.json(resp);
  } catch (error) {
    return internalError(error);
  }
}
