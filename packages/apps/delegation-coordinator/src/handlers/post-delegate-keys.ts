/**
 * POST /api/sealer/delegate-keys — register a sealer's standing delegate keys.
 *
 * Delegate keys are per-sealer, but the store is sharded per-log and coverage
 * retrieval LEFT JOINs delegate_keys against a log's certificates within a
 * single shard. So registration must reach EVERY shard — this handler fans the
 * idempotent upsert out to all of them. App-token authenticated (the sealer is
 * a trusted first party, like POST /api/delegations). FOR-390 phase C.
 */

import type { Env } from "../env.js";
import { checkBearerToken } from "../auth/check-bearer-token.js";
import type { RegisterDelegateKeysRequest } from "../types/register-delegate-keys-request.js";
import {
  getShardCount,
  getStoreStub,
  internalError,
  problemResponse,
} from "./handler.js";

/**
 * POST /api/sealer/delegate-keys — fan-out delegate-key registration.
 *
 * @param request - JSON {@link RegisterDelegateKeysRequest} body.
 * @param env - Worker bindings.
 * @returns `{ registered, retired, shards }` or a problem Response.
 */
export async function handlePostDelegateKeys(
  request: Request,
  env: Env,
): Promise<Response> {
  try {
    const authErr = checkBearerToken(request, env.COORDINATOR_APP_TOKEN);
    if (authErr) return authErr;

    const contentType = request.headers.get("Content-Type") ?? "";
    if (!contentType.includes("application/json")) {
      return problemResponse(
        415,
        "about:blank",
        "Unsupported Media Type",
        "Content-Type must be application/json",
      );
    }

    const body = (await request.json()) as RegisterDelegateKeysRequest;
    if (!body.sealerId || !Array.isArray(body.keys) || body.keys.length === 0) {
      return problemResponse(
        400,
        "about:blank",
        "Invalid request",
        "sealerId and a non-empty keys[] are required",
      );
    }

    const payload = JSON.stringify(body);
    const shardCount = getShardCount(env);

    // Fan out to every shard. A single shard rejecting (e.g. a malformed key)
    // is a client error that applies to all, so surface the first non-2xx.
    const results = await Promise.all(
      Array.from({ length: shardCount }, (_, i) =>
        getStoreStub(env, i).fetch("https://do.internal/sealer/delegate-keys", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: payload,
        }),
      ),
    );

    let registered = 0;
    let retired = 0;
    for (const res of results) {
      if (!res.ok) {
        // Propagate the shard's problem document verbatim.
        return new Response(res.body, {
          status: res.status,
          headers: res.headers,
        });
      }
      const shardResult = (await res.json()) as {
        registered: number;
        retired: number;
      };
      // Identical keys are written to each shard; report the per-shard count
      // once (max), and the total retired across shards.
      registered = Math.max(registered, shardResult.registered);
      retired += shardResult.retired;
    }

    return Response.json({ registered, retired, shards: shardCount });
  } catch (error) {
    return internalError(error);
  }
}
