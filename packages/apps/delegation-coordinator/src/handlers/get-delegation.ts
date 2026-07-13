/**
 * GET /api/logs/{logId}/delegation — public current-certificate read (C2).
 *
 * Returns the newest unexpired delegation certificate for a log (ties broken by
 * widest range). Public and unauthenticated: certificates are public material
 * (embedded at label 1000 in every published checkpoint). Signers use
 * expiresAt/mmrEnd to anticipate renewal; verify/demo tooling reads the current
 * cert. Standard edge volumetric protection applies (canopy ADR-0008).
 */

import type { Env } from "../env.js";
import {
  forwardToStore,
  internalError,
  normalizePathLogId,
  problemResponse,
} from "./handler.js";

/**
 * GET delegation for a log id path segment.
 *
 * @param logIdSegment - Raw URL log id segment.
 * @param _request - Unused (public route).
 * @param env - Worker bindings.
 */
export async function handleGetDelegation(
  logIdSegment: string,
  _request: Request,
  env: Env,
): Promise<Response> {
  try {
    const logIdHex32 = normalizePathLogId(logIdSegment);
    if (logIdHex32 instanceof Response) return logIdHex32;

    const storePath = `/delegation?logId=${encodeURIComponent(logIdHex32)}`;
    const resp = await forwardToStore(env, logIdHex32, storePath, {
      method: "GET",
    });
    // 200 and 404 are the store's own responses; pass them through verbatim.
    if (resp.status !== 200 && resp.status !== 404) {
      const detail = await resp.text();
      return problemResponse(
        502,
        "about:blank",
        "Delegation query failed",
        detail,
      );
    }
    return new Response(resp.body, {
      status: resp.status,
      headers: resp.headers,
    });
  } catch (error) {
    return internalError(error);
  }
}
