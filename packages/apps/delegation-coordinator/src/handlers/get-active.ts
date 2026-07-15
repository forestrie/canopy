/**
 * GET /api/delegations/active — server-side-aggregated active-delegation set
 * for the sealer's level-triggered resync (arbor plan-2607-04, ADR-0007 phase
 * 3 sweep).
 *
 * Returns one keyset page of logs holding a delegation cert whose
 * `expires_at > now - graceSeconds` (active OR recently expired). The
 * coordinator owns the fan-out over its {@link getShardCount} shards — the
 * sealer sees only an **opaque cursor**, never the shard count, so resharding
 * is transparent and there is no shard-count config for the sealer to drift.
 *
 * Paging is **shard-by-shard**: a resync needs no global ordering, so each
 * request drains at most one shard (one DO round-trip). The opaque cursor
 * carries `(shardIndex, withinShardKey)`; when a shard is exhausted the cursor
 * advances to the next shard, and a null cursor means the whole set was walked.
 *
 * Authenticated with {@link Env.COORDINATOR_APP_TOKEN} — the same bearer the
 * sealer already presents to `POST /api/delegations`.
 */

import type { Env } from "../env.js";
import { checkBearerToken } from "../auth/check-bearer-token.js";
import {
  getShardCount,
  getStoreStub,
  internalError,
  problemResponse,
} from "./handler.js";

/** Per-log active-delegation summary returned to the sealer resync. */
interface ActiveLog {
  logIdHex32: string;
  /** Furthest cert expiry for this log (epoch seconds). */
  expiresAt: number;
  /** Lowest authorized mmr start across this log's certs, or null if unknown. */
  mmrStart: number | null;
  /**
   * Highest authorized mmr end across this log's certs, or null if unknown.
   * The sealer resync uses this to hint how far the log should be sealed.
   */
  mmrEnd: number | null;
}

/** Default grace window (seconds) when the caller does not specify one. */
const DEFAULT_GRACE_SECONDS = 60 * 60;
/** Upper bound on the grace window a caller may request. */
const MAX_GRACE_SECONDS = 24 * 60 * 60;
/** Default page size when the caller does not specify one. */
const DEFAULT_LIMIT = 100;
/** Upper bound on page size (mirrors the DO-side clamp). */
const MAX_LIMIT = 500;

/** Opaque cursor payload: which shard, and the keyset position within it. */
interface Cursor {
  s: number;
  k: string;
}

/** Encode `(shardIndex, withinShardKey)` as an opaque base64url token. */
function encodeCursor(c: Cursor): string {
  const json = JSON.stringify(c);
  return btoa(json).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Decode an opaque cursor. Returns the start position `(0, "")` when absent,
 * and null when malformed (caller answers 400).
 */
function decodeCursor(raw: string | null, shardCount: number): Cursor | null {
  if (!raw) return { s: 0, k: "" };
  try {
    const b64 = raw.replace(/-/g, "+").replace(/_/g, "/");
    const parsed = JSON.parse(atob(b64)) as unknown;
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      typeof (parsed as Cursor).s !== "number" ||
      typeof (parsed as Cursor).k !== "string"
    ) {
      return null;
    }
    const c = parsed as Cursor;
    if (!Number.isInteger(c.s) || c.s < 0 || c.s >= shardCount) return null;
    return c;
  } catch {
    return null;
  }
}

/** GET /api/delegations/active — one keyset page across the delegation shards. */
export async function handleGetActive(
  request: Request,
  env: Env,
): Promise<Response> {
  try {
    const authErr = checkBearerToken(request, env.COORDINATOR_APP_TOKEN);
    if (authErr) return authErr;

    const url = new URL(request.url);
    const shardCount = getShardCount(env);

    const cursor = decodeCursor(url.searchParams.get("cursor"), shardCount);
    if (!cursor) {
      return problemResponse(
        400,
        "about:blank",
        "Invalid request",
        "cursor is malformed or out of range",
      );
    }

    const graceRaw = parseInt(
      url.searchParams.get("graceSeconds") ?? String(DEFAULT_GRACE_SECONDS),
      10,
    );
    const graceSeconds = Number.isNaN(graceRaw)
      ? DEFAULT_GRACE_SECONDS
      : Math.min(Math.max(0, graceRaw), MAX_GRACE_SECONDS);

    const limitRaw = parseInt(
      url.searchParams.get("limit") ?? String(DEFAULT_LIMIT),
      10,
    );
    const limit = Number.isNaN(limitRaw)
      ? DEFAULT_LIMIT
      : Math.min(Math.max(1, limitRaw), MAX_LIMIT);

    const now = Math.floor(Date.now() / 1000);
    const threshold = now - graceSeconds;

    // Drain the current shard from its keyset position. If exhausted, advance
    // to the next shard; a null next-cursor means the whole set was walked.
    const storeUrl = new URL("https://do.internal/active");
    storeUrl.searchParams.set("threshold", String(threshold));
    storeUrl.searchParams.set("after", cursor.k);
    storeUrl.searchParams.set("limit", String(limit));

    const resp = await getStoreStub(env, cursor.s).fetch(storeUrl.toString(), {
      method: "GET",
    });
    if (!resp.ok) {
      const detail = await resp.text();
      return problemResponse(502, "about:blank", "Shard query failed", detail);
    }
    const { logs, nextKey } = (await resp.json()) as {
      logs: ActiveLog[];
      nextKey: string | null;
    };

    let nextCursor: string | null;
    if (nextKey !== null) {
      // More rows remain in this shard.
      nextCursor = encodeCursor({ s: cursor.s, k: nextKey });
    } else if (cursor.s + 1 < shardCount) {
      // Shard exhausted; continue at the start of the next shard.
      nextCursor = encodeCursor({ s: cursor.s + 1, k: "" });
    } else {
      // Last shard exhausted: full walk complete.
      nextCursor = null;
    }

    return Response.json({
      logs,
      cursor: nextCursor,
      graceSeconds,
      limit,
    });
  } catch (error) {
    return internalError(error);
  }
}
