/**
 * Handler for GET /api/logs/{logId}/pending-delegation — sealer poll (public).
 */

import type { Env } from "../env.js";
import type { PendingEntry } from "../types/pending-entry.js";
import {
  forwardToStore,
  internalError,
  normalizePathLogId,
  problemResponse,
} from "./handler.js";

export async function handleGetPendingDelegation(
  logIdSegment: string,
  _request: Request,
  env: Env,
): Promise<Response> {
  try {
    const logIdHex32 = normalizePathLogId(logIdSegment);
    if (logIdHex32 instanceof Response) return logIdHex32;

    const storePath = `/pending-delegation?logId=${encodeURIComponent(
      logIdHex32,
    )}`;
    const resp = await forwardToStore(env, logIdHex32, storePath, {
      method: "GET",
    });
    if (!resp.ok) {
      const detail = await resp.text();
      return problemResponse(
        502,
        "about:blank",
        "Pending delegation query failed",
        detail,
      );
    }

    const json = (await resp.json()) as {
      entries: PendingEntry[];
      limit?: number;
    };
    return Response.json({ entries: json.entries, limit: json.limit });
  } catch (error) {
    return internalError(error);
  }
}
