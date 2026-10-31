/**
 * POST and DELETE /admin/api/sealer/delegate-keys/tombstones — retire a
 * standing delegate key, or lift that retirement (plan-2609-12 slice 08,
 * ruling 8).
 *
 * A tombstone is the only way to retire a key faster than its voucher
 * expires: disabling a KMS MAC key version stops new vouchers, but a voucher
 * already issued stays valid for its lifetime and anyone holding it could
 * re-register the key. A tombstone names one key hash, or a sealer with every
 * epoch up to `maxEpoch`; it is written to every shard together with the
 * deletion of the matching `delegate_keys` rows, and from then on each shard
 * refuses that key's registration with 410, which the arbor sealer treats as
 * final. Coverage queries already require a registered row, so a tombstoned
 * key's certificates stop being served at once. Procedure:
 * [devdocs ops-0016](https://github.com/forestrie/devdocs/blob/main/ops/ops-0016-kms-mac-key-version-rotation.md).
 *
 * Operator plane: gated by {@link requireOperatorTokenOrResponse} under
 * `/admin/api/`, which refuses wallet-challenge sessions (canopy rule C9).
 */

import type { Env } from "../env.js";
import { requireOperatorTokenOrResponse } from "../auth/authorize.js";
import type {
  DelegateKeyTombstoneRequest,
  PubkeyHashTombstoneTarget,
  SealerEpochTombstoneTarget,
} from "../types/delegate-key-tombstone-request.js";
import { PUBKEY_HASH_HEX } from "./get-delegate-key.js";
import {
  getShardCount,
  getStoreStub,
  internalError,
  problemResponse,
} from "./handler.js";

/** Longest accepted reason; it is echoed in every 410. */
const MAX_REASON_LENGTH = 500;

type TombstoneTarget = PubkeyHashTombstoneTarget | SealerEpochTombstoneTarget;

/**
 * POST /admin/api/sealer/delegate-keys/tombstones.
 *
 * Idempotent: a repeated tombstone keeps the first one's reason and time, and
 * still deletes any matching row.
 *
 * @param request - JSON {@link DelegateKeyTombstoneRequest} (operator token).
 * @param env - Worker bindings.
 * @returns 200 `{ deleted, shards }` once every shard holds the tombstone,
 *   where `deleted` is the row count on one shard (replicas hold the same
 *   rows), or a problem Response.
 */
export async function handleAdminPostDelegateKeyTombstone(
  request: Request,
  env: Env,
): Promise<Response> {
  try {
    const authErr = requireOperatorTokenOrResponse(request, env);
    if (authErr) return authErr;

    let body: Partial<DelegateKeyTombstoneRequest> & Record<string, unknown>;
    try {
      body = (await request.json()) as typeof body;
    } catch {
      return invalid("body must be JSON");
    }
    if (!body || typeof body !== "object") return invalid("body must be JSON");
    const target = parseTombstoneTarget(
      body.pubkeyHash,
      body.sealerId,
      body.maxEpoch,
    );
    if (target instanceof Response) return target;
    const reason = typeof body.reason === "string" ? body.reason.trim() : "";
    if (!reason) return invalid("reason is required");
    if (reason.length > MAX_REASON_LENGTH) {
      return invalid(`reason must be at most ${MAX_REASON_LENGTH} characters`);
    }

    // One createdAt for every replica, so the listing merges them.
    const payload = JSON.stringify({
      ...target,
      reason,
      createdAt: Math.floor(Date.now() / 1000),
    });
    const results = await fanOut(env, (stub) =>
      stub.fetch("https://do.internal/sealer/delegate-key-tombstones", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: payload,
      }),
    );
    if (results instanceof Response) return results;
    const deleted = Math.max(
      0,
      ...results.map((r) => (r as { deleted: number }).deleted),
    );

    console.log(
      JSON.stringify({
        event: "delegate_key_tombstoned",
        ...target,
        reason,
        deleted,
        shards: results.length,
      }),
    );
    return Response.json({ deleted, shards: results.length });
  } catch (error) {
    return internalError(error);
  }
}

/**
 * DELETE /admin/api/sealer/delegate-keys/tombstones?pubkeyHash= or
 * ?sealerId=&maxEpoch= — lift exactly that tombstone, for an operator
 * mistake. Rows it deleted are not restored; the sealer's next assertion
 * re-creates them.
 *
 * @param request - Incoming HTTP request (operator token).
 * @param url - Parsed request URL carrying the target.
 * @param env - Worker bindings.
 * @returns 200 `{ lifted, shards }` where `lifted` is 0 or 1, or a problem
 *   Response.
 */
export async function handleAdminDeleteDelegateKeyTombstone(
  request: Request,
  url: URL,
  env: Env,
): Promise<Response> {
  try {
    const authErr = requireOperatorTokenOrResponse(request, env);
    if (authErr) return authErr;

    const q = url.searchParams;
    const maxEpoch = q.get("maxEpoch");
    const target = parseTombstoneTarget(
      q.get("pubkeyHash") ?? undefined,
      q.get("sealerId") ?? undefined,
      maxEpoch === null || maxEpoch === "" ? undefined : Number(maxEpoch),
    );
    if (target instanceof Response) return target;

    const query = new URLSearchParams(
      "pubkeyHash" in target
        ? { pubkeyHash: target.pubkeyHash }
        : { sealerId: target.sealerId, maxEpoch: String(target.maxEpoch) },
    );
    const results = await fanOut(env, (stub) =>
      stub.fetch(
        `https://do.internal/sealer/delegate-key-tombstones?${query}`,
        { method: "DELETE" },
      ),
    );
    if (results instanceof Response) return results;
    const lifted = Math.max(
      0,
      ...results.map((r) => (r as { lifted: number }).lifted),
    );

    console.log(
      JSON.stringify({
        event: "delegate_key_tombstone_lifted",
        ...target,
        lifted,
        shards: results.length,
      }),
    );
    return Response.json({ lifted, shards: results.length });
  } catch (error) {
    return internalError(error);
  }
}

/**
 * Validate a tombstone target: exactly one of a key hash, or a sealer id
 * with an integer `maxEpoch` >= 1.
 *
 * @returns The target, or a 400 problem Response.
 */
function parseTombstoneTarget(
  pubkeyHash: unknown,
  sealerId: unknown,
  maxEpoch: unknown,
): TombstoneTarget | Response {
  const hasSealer = sealerId !== undefined || maxEpoch !== undefined;
  if (pubkeyHash !== undefined) {
    if (hasSealer) {
      return invalid(
        "give either pubkeyHash or sealerId with maxEpoch, not both",
      );
    }
    if (typeof pubkeyHash !== "string" || !PUBKEY_HASH_HEX.test(pubkeyHash)) {
      return invalid("pubkeyHash must be 64 lowercase hex characters");
    }
    return { pubkeyHash };
  }
  if (typeof sealerId !== "string" || !sealerId.trim()) {
    return invalid("pubkeyHash, or sealerId with maxEpoch, is required");
  }
  if (
    typeof maxEpoch !== "number" ||
    !Number.isSafeInteger(maxEpoch) ||
    maxEpoch < 1
  ) {
    return invalid("maxEpoch must be an integer >= 1");
  }
  return { sealerId: sealerId.trim(), maxEpoch };
}

/**
 * Send one request to every shard and require each to succeed.
 *
 * @returns Every shard's JSON answer, or the first failing shard's problem
 *   verbatim.
 */
async function fanOut(
  env: Env,
  send: (stub: ReturnType<typeof getStoreStub>) => Promise<Response>,
): Promise<unknown[] | Response> {
  const results = await Promise.all(
    Array.from({ length: getShardCount(env) }, (_, i) =>
      send(getStoreStub(env, i)),
    ),
  );
  const bodies: unknown[] = [];
  for (const res of results) {
    if (!res.ok) {
      return new Response(res.body, {
        status: res.status,
        headers: res.headers,
      });
    }
    bodies.push(await res.json());
  }
  return bodies;
}

/** 400 problem for a malformed tombstone request. */
function invalid(detail: string): Response {
  return problemResponse(400, "about:blank", "Invalid request", detail);
}
