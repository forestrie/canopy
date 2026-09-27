/**
 * GET /api/sealer/delegate-keys?sealerId= — list a sealer's registered
 * standing delegate keys with certificate coverage evidence (plan-2609-12
 * slice 04, ruling 4).
 *
 * This is the verification surface for a MAC-key rotation
 * ([devdocs ops-0016](https://github.com/forestrie/devdocs/blob/main/ops/ops-0016-kms-mac-key-version-rotation.md)):
 * after the custodian re-registers, an operator reads which hash holds each
 * epoch and how many unexpired certificates are bound to it, instead of
 * reading custodian logs. Keys are replicated to every shard but certificates
 * live on their log's shard, so the worker merges the per-shard listings:
 * certificate counts are summed, and `shardsRegistered` exposes an incomplete
 * fan-out.
 *
 * Authenticated with {@link Env.COORDINATOR_APP_TOKEN}; public key metadata
 * only.
 */

import type { Env } from "../env.js";
import { checkBearerToken } from "../auth/check-bearer-token.js";
import type {
  DelegateKeysListing,
  DelegateKeysListingEntry,
} from "../types/delegate-keys-listing.js";
import {
  getShardCount,
  getStoreStub,
  internalError,
  problemResponse,
} from "./handler.js";

/** One shard's listing: its replica rows with that shard's certificate counts. */
interface ShardListing {
  keys: Array<Omit<DelegateKeysListingEntry, "shardsRegistered">>;
}

/**
 * GET /api/sealer/delegate-keys?sealerId=.
 *
 * @param request - Incoming HTTP request (bearer app token).
 * @param url - Parsed request URL carrying the `sealerId` query parameter.
 * @param env - Worker bindings.
 * @returns 200 {@link DelegateKeysListing} or a problem Response.
 */
export async function handleListDelegateKeys(
  request: Request,
  url: URL,
  env: Env,
): Promise<Response> {
  try {
    const authErr = checkBearerToken(request, env.COORDINATOR_APP_TOKEN);
    if (authErr) return authErr;

    const sealerId = requireSealerId(url);
    if (sealerId instanceof Response) return sealerId;

    const shardCount = getShardCount(env);
    const results = await Promise.all(
      Array.from({ length: shardCount }, (_, i) =>
        getStoreStub(env, i).fetch(
          `https://do.internal/sealer/delegate-keys?sealerId=${encodeURIComponent(sealerId)}`,
        ),
      ),
    );

    const merged = new Map<string, DelegateKeysListingEntry>();
    for (const res of results) {
      if (!res.ok) {
        return new Response(res.body, {
          status: res.status,
          headers: res.headers,
        });
      }
      const shard = (await res.json()) as ShardListing;
      for (const key of shard.keys) {
        const existing = merged.get(key.pubkeyHash);
        if (!existing) {
          merged.set(key.pubkeyHash, { ...key, shardsRegistered: 1 });
          continue;
        }
        existing.unexpiredCertificates += key.unexpiredCertificates;
        existing.shardsRegistered += 1;
        // Replicas of one registration agree; if a fan-out was interrupted
        // between two registrations, surface the most recent landing.
        if ((key.registeredAt ?? 0) > (existing.registeredAt ?? 0)) {
          existing.registeredAt = key.registeredAt;
          existing.epoch = key.epoch;
          existing.notAfter = key.notAfter;
        }
      }
    }

    const keys = [...merged.values()].sort(
      (a, b) => b.epoch - a.epoch || a.pubkeyHash.localeCompare(b.pubkeyHash),
    );
    const body: DelegateKeysListing = { sealerId, shards: shardCount, keys };
    return Response.json(body);
  } catch (error) {
    return internalError(error);
  }
}

/**
 * Read the required, non-empty `sealerId` query parameter.
 *
 * @param url - Parsed request URL.
 * @returns The sealer id, or a 400 problem Response.
 */
export function requireSealerId(url: URL): string | Response {
  const sealerId = url.searchParams.get("sealerId")?.trim() ?? "";
  if (!sealerId) {
    return problemResponse(
      400,
      "about:blank",
      "Invalid request",
      "sealerId query parameter is required",
    );
  }
  return sealerId;
}
