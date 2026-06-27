/**
 * GET /api/logs/{logId}/signing-route — read per-log signing configuration.
 *
 * Requires wallet session scope `logs:signing-route:read` or app token
 * fallback per [ARC-0017](https://github.com/forestrie/devdocs/blob/main/arc/arc-0017-hierarchical-authority-logs-and-fee-distribution.md).
 */

import type { Env } from "../env.js";
import { requireUserSessionOrResponse } from "../auth/authorize.js";
import {
  forwardToStore,
  internalError,
  normalizePathLogId,
} from "./handler.js";

/** GET signing route JSON for a log. */
export async function handleGetSigningRoute(
  logIdSegment: string,
  request: Request,
  env: Env,
): Promise<Response> {
  try {
    const logIdHex32 = normalizePathLogId(logIdSegment);
    if (logIdHex32 instanceof Response) return logIdHex32;

    const authErr = requireUserSessionOrResponse(request, env, {
      scope: "logs:signing-route:read",
      logIdHex32,
    });
    if (authErr) return authErr;

    return forwardToStore(env, logIdHex32, `/signing-route/${logIdHex32}`, {
      method: "GET",
    });
  } catch (error) {
    return internalError(error);
  }
}
