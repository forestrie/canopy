/**
 * Handler for GET /api/logs/{logId}/webhook
 */

import type { Env } from "../env.js";
import { checkBearerToken } from "../auth/check-bearer-token.js";
import { issuerTokenForLog } from "../auth/issuer-token-for-log.js";
import {
  forwardToStore,
  internalError,
  normalizePathLogId,
} from "./handler.js";

export async function handleGetWebhook(
  logIdSegment: string,
  request: Request,
  env: Env,
): Promise<Response> {
  try {
    const logIdHex32 = normalizePathLogId(logIdSegment);
    if (logIdHex32 instanceof Response) return logIdHex32;

    const issuerToken = await issuerTokenForLog(env, logIdHex32);
    const authErr = checkBearerToken(
      request,
      env.COORDINATOR_APP_TOKEN,
      issuerToken,
    );
    if (authErr) return authErr;

    return forwardToStore(env, logIdHex32, `/webhook/${logIdHex32}`, {
      method: "GET",
    });
  } catch (error) {
    return internalError(error);
  }
}
