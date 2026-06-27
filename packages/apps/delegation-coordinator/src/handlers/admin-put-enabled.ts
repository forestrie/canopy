/**
 * PUT /admin/api/logs/{logId}/enabled — operator service gate write.
 */

import type { Env } from "../env.js";
import { requireOperatorTokenOrResponse } from "../auth/authorize.js";
import type { PutEnabledRequest } from "../types/put-enabled-request.js";
import {
  forwardToStore,
  internalError,
  normalizePathLogId,
  problemResponse,
} from "./handler.js";

/** Admin PUT operator_enabled (operator token). */
export async function handleAdminPutEnabled(
  logIdSegment: string,
  request: Request,
  env: Env,
): Promise<Response> {
  try {
    const authErr = requireOperatorTokenOrResponse(request, env);
    if (authErr) return authErr;

    const logIdHex32 = normalizePathLogId(logIdSegment);
    if (logIdHex32 instanceof Response) return logIdHex32;

    const body = (await request.json()) as PutEnabledRequest;
    if (typeof body.enabled !== "boolean") {
      return problemResponse(
        400,
        "about:blank",
        "Invalid request",
        "enabled must be a boolean",
      );
    }

    return forwardToStore(env, logIdHex32, `/enabled/${logIdHex32}/operator`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (error) {
    return internalError(error);
  }
}
