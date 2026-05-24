/**
 * Handler for GET /api/delegations/pending — fan-out all shards.
 */

import type { Env } from "../env.js";
import { checkBearerToken } from "../auth/check-bearer-token.js";
import { normalizeLogIdToHex32 } from "../log-id.js";
import type { PendingEntry } from "../types/pending-entry.js";
import {
  getShardCount,
  getStoreStub,
  internalError,
  problemResponse,
} from "./handler.js";

export async function handleGetPending(
  request: Request,
  env: Env,
): Promise<Response> {
  try {
    const authErr = checkBearerToken(request, env.COORDINATOR_APP_TOKEN);
    if (authErr) return authErr;

    const url = new URL(request.url);
    const metaUrl = new URL("https://coordinator.local/pending");
    for (const key of ["offset", "limit"]) {
      const value = url.searchParams.get(key);
      if (value !== null) metaUrl.searchParams.set(key, value);
    }

    const authLogIdParam = url.searchParams.get("authLogId");
    if (!authLogIdParam) {
      return problemResponse(
        400,
        "about:blank",
        "Invalid request",
        "authLogId query parameter is required",
      );
    }

    let authLogIdHex32: string;
    try {
      authLogIdHex32 = normalizeLogIdToHex32(authLogIdParam);
    } catch (error) {
      return problemResponse(
        400,
        "about:blank",
        "Invalid request",
        error instanceof Error ? error.message : "Invalid authLogId",
      );
    }

    metaUrl.searchParams.set("authLogId", authLogIdHex32);

    const shardCount = getShardCount(env);
    const slices = await Promise.all(
      Array.from({ length: shardCount }, (_, shardIndex) =>
        getStoreStub(env, shardIndex).fetch(metaUrl.toString(), {
          method: "GET",
        }),
      ),
    );

    const entries: PendingEntry[] = [];
    let offset = 0;
    let limit = 100;

    for (const slice of slices) {
      if (!slice.ok) {
        const detail = await slice.text();
        return problemResponse(
          502,
          "about:blank",
          "Shard query failed",
          detail,
        );
      }
      const json = (await slice.json()) as {
        entries: PendingEntry[];
        offset?: number;
        limit?: number;
      };
      entries.push(...json.entries);
      if (json.offset !== undefined) offset = json.offset;
      if (json.limit !== undefined) limit = json.limit;
    }

    entries.sort((a, b) => b.requestedAt - a.requestedAt);

    return Response.json({ entries, offset, limit, shardCount });
  } catch (error) {
    return internalError(error);
  }
}
