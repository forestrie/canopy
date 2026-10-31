/**
 * GET /api/sealer/delegate-keys/{pubkeyHash} — lookup of one registered
 * standing delegate key (plan-2609-12 slice 04, ruling 1).
 *
 * An operator read since the sealer asserts its own registration (ruling 1′):
 * a delegate key is "registered" only once the fan-out has landed on EVERY
 * shard, because a log's coverage retrieval reads `delegate_keys` on that
 * log's shard alone. So the lookup consults all shards and reports 404 for a
 * partial registration, and, like coverage, for an expired row (slice 08).
 *
 * Authenticated with {@link Env.COORDINATOR_APP_TOKEN}, like the sibling
 * `POST /api/sealer/delegate-keys`. The data is public key metadata.
 */

import type { Env } from "../env.js";
import { checkBearerToken } from "../auth/check-bearer-token.js";
import type { DelegateKeyRecord } from "../types/delegate-key-record.js";
import {
  getShardCount,
  getStoreStub,
  internalError,
  problemResponse,
} from "./handler.js";

/** Lowercase hex sha256, the `delegate_keys.pubkey_hash` shape. */
export const PUBKEY_HASH_HEX = /^[0-9a-f]{64}$/;

/**
 * GET /api/sealer/delegate-keys/{pubkeyHash}.
 *
 * @param pubkeyHash - Raw path segment; must be 64 lowercase hex chars.
 * @param request - Incoming HTTP request (bearer app token).
 * @param env - Worker bindings.
 * @returns 200 with the {@link DelegateKeyRecord} plus `shards`, 404 when the
 *   key is not registered on every shard, or a problem Response.
 */
export async function handleGetDelegateKey(
  pubkeyHash: string,
  request: Request,
  env: Env,
): Promise<Response> {
  try {
    const authErr = checkBearerToken(request, env.COORDINATOR_APP_TOKEN);
    if (authErr) return authErr;

    if (!PUBKEY_HASH_HEX.test(pubkeyHash)) {
      return problemResponse(
        400,
        "about:blank",
        "Invalid request",
        "pubkeyHash must be 64 lowercase hex characters",
      );
    }

    const shardCount = getShardCount(env);
    const results = await Promise.all(
      Array.from({ length: shardCount }, (_, i) =>
        getStoreStub(env, i).fetch(
          `https://do.internal/sealer/delegate-keys/${pubkeyHash}`,
        ),
      ),
    );

    let record: DelegateKeyRecord | undefined;
    let found = 0;
    for (const res of results) {
      if (res.status === 404) continue;
      if (!res.ok) {
        return new Response(res.body, {
          status: res.status,
          headers: res.headers,
        });
      }
      found += 1;
      // Rows are replicas of one registration; the first is representative.
      record ??= (await res.json()) as DelegateKeyRecord;
    }

    if (!record || found < shardCount) {
      return problemResponse(
        404,
        "about:blank",
        "Not Found",
        found === 0
          ? `delegate key ${pubkeyHash} is not registered`
          : `delegate key ${pubkeyHash} is registered on ${found} of ${shardCount} shards; registration is incomplete`,
      );
    }

    return Response.json({ ...record, shards: shardCount });
  } catch (error) {
    return internalError(error);
  }
}
