/**
 * GET /admin/api/logs/{logId}/enabled — operator service gate read.
 */

import type { Env } from "../env.js";
import { requireOperatorTokenOrResponse } from "../auth/authorize.js";
import {
  forwardToStore,
  internalError,
  normalizePathLogId,
} from "./handler.js";

/** Admin GET enabled flags (operator token). */
export async function handleAdminGetEnabled(
  logIdSegment: string,
  request: Request,
  env: Env,
): Promise<Response> {
  try {
    const authErr = requireOperatorTokenOrResponse(request, env);
    if (authErr) return authErr;

    const logIdHex32 = normalizePathLogId(logIdSegment);
    if (logIdHex32 instanceof Response) return logIdHex32;

    return forwardToStore(env, logIdHex32, `/enabled/${logIdHex32}`, {
      method: "GET",
    });
  } catch (error) {
    return internalError(error);
  }
}
