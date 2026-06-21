/**
 * Handler for PUT /api/logs/{logId}/enabled
 */

import type { Env } from "../env.js";
import { checkBearerToken } from "../auth/check-bearer-token.js";
import type { PutEnabledRequest } from "../types/put-enabled-request.js";
import {
  forwardToStore,
  internalError,
  normalizePathLogId,
  problemResponse,
} from "./handler.js";

export async function handlePutEnabled(
  logIdSegment: string,
  request: Request,
  env: Env,
): Promise<Response> {
  try {
    const authErr = checkBearerToken(request, env.COORDINATOR_APP_TOKEN);
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

    return forwardToStore(env, logIdHex32, `/enabled/${logIdHex32}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (error) {
    return internalError(error);
  }
}
