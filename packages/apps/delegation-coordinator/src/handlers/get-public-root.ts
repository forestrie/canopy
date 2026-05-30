/**
 * Handler for GET /api/logs/{logId}/public-root
 */

import type { Env } from "../env.js";
import { checkBearerToken } from "../auth/check-bearer-token.js";
import {
  forwardToStore,
  internalError,
  normalizePathLogId,
} from "./handler.js";

export async function handleGetPublicRoot(
  logIdSegment: string,
  request: Request,
  env: Env,
): Promise<Response> {
  try {
    const authErr = checkBearerToken(request, env.COORDINATOR_APP_TOKEN);
    if (authErr) return authErr;

    const logIdHex32 = normalizePathLogId(logIdSegment);
    if (logIdHex32 instanceof Response) return logIdHex32;

    return forwardToStore(env, logIdHex32, `/public-root/${logIdHex32}`, {
      method: "GET",
      headers: { Accept: "application/cbor" },
    });
  } catch (error) {
    return internalError(error);
  }
}
