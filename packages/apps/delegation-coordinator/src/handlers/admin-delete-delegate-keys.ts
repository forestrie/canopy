/**
 * DELETE /admin/api/sealer/delegate-keys?sealerId= — remove every registered
 * standing delegate key of one sealer (plan-2609-12 slice 04, ruling 4).
 *
 * Registration enforces one key per (sealerId, epoch), so replacing the
 * custodian's MAC key (which changes every derived key) needs this deliberate
 * admin action first; see
 * [devdocs ops-0016](https://github.com/forestrie/devdocs/blob/main/ops/ops-0016-kms-mac-key-version-rotation.md).
 * It is scoped to one sealer and never a blanket wipe. Certificates already
 * bound to the removed keys are left in place: coverage retrieval only serves
 * certificates bound to keys the requesting sealer still holds (FOR-586).
 *
 * Operator plane: gated by {@link requireOperatorTokenOrResponse} under
 * `/admin/api/`, which refuses wallet-challenge sessions (canopy rule C9).
 * The sealer-facing app-token routes under `/api/sealer/` cannot delete.
 */

import type { Env } from "../env.js";
import { requireOperatorTokenOrResponse } from "../auth/authorize.js";
import { getShardCount, getStoreStub, internalError } from "./handler.js";
import { requireSealerId } from "./list-delegate-keys.js";

/**
 * DELETE /admin/api/sealer/delegate-keys?sealerId=.
 *
 * @param request - Incoming HTTP request (operator bearer token).
 * @param url - Parsed request URL carrying the `sealerId` query parameter.
 * @param env - Worker bindings.
 * @returns 200 `{ sealerId, deleted, shards }` where `deleted` is the row
 *   count on one shard (replicas hold the same rows), or a problem Response.
 */
export async function handleAdminDeleteDelegateKeys(
  request: Request,
  url: URL,
  env: Env,
): Promise<Response> {
  try {
    const authErr = requireOperatorTokenOrResponse(request, env);
    if (authErr) return authErr;

    const sealerId = requireSealerId(url);
    if (sealerId instanceof Response) return sealerId;

    const shardCount = getShardCount(env);
    const results = await Promise.all(
      Array.from({ length: shardCount }, (_, i) =>
        getStoreStub(env, i).fetch(
          `https://do.internal/sealer/delegate-keys?sealerId=${encodeURIComponent(sealerId)}`,
          { method: "DELETE" },
        ),
      ),
    );

    let deleted = 0;
    for (const res of results) {
      if (!res.ok) {
        return new Response(res.body, {
          status: res.status,
          headers: res.headers,
        });
      }
      const shard = (await res.json()) as { deleted: number };
      deleted = Math.max(deleted, shard.deleted);
    }

    console.log(
      JSON.stringify({
        event: "delegate_keys_deleted",
        sealerId,
        deleted,
        shards: shardCount,
      }),
    );
    return Response.json({ sealerId, deleted, shards: shardCount });
  } catch (error) {
    return internalError(error);
  }
}
