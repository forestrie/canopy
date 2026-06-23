/**
 * Handler for POST /api/logs/{logId}/signing-route
 */

import type { Env } from "../env.js";
import { requireUserSessionOrResponse } from "../auth/authorize.js";
import type { SigningRoute } from "../types/signing-route.js";
import {
  forwardToStore,
  internalError,
  normalizePathLogId,
  problemResponse,
} from "./handler.js";

export async function handlePostSigningRoute(
  logIdSegment: string,
  request: Request,
  env: Env,
): Promise<Response> {
  try {
    const logIdHex32 = normalizePathLogId(logIdSegment);
    if (logIdHex32 instanceof Response) return logIdHex32;

    const authErr = requireUserSessionOrResponse(request, env, {
      scope: "logs:signing-route:write",
      logIdHex32,
    });
    if (authErr) return authErr;

    const body = (await request.json()) as SigningRoute;
    if (body.mode !== "wallet" && body.mode !== "http") {
      return problemResponse(
        400,
        "about:blank",
        "Invalid request",
        "mode must be wallet or http",
      );
    }

    return forwardToStore(env, logIdHex32, `/signing-route/${logIdHex32}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (error) {
    return internalError(error);
  }
}
