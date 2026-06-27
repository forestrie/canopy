/**
 * Handler for PUT /api/logs/{logId}/enabled
 *
 * User session -> user_enabled (kill switch).
 * App token (transitional) -> operator_enabled (service gate).
 */

import type { Env } from "../env.js";
import {
  requireOperatorTokenOrAppTokenOrResponse,
  requireUserSessionOrResponse,
} from "../auth/authorize.js";
import { parseBearerSession } from "../auth/wallet-challenge/session-token.js";
import type { PutEnabledRequest } from "../types/put-enabled-request.js";
import {
  forwardToStore,
  internalError,
  normalizePathLogId,
  problemResponse,
} from "./handler.js";

/** True when wallet-challenge auth endpoints are enabled. */
function walletChallengeEnabled(env: Env): boolean {
  return env.ENABLE_WALLET_CHALLENGE?.trim().toLowerCase() === "true";
}

/**
 * PUT enabled kill-switch — user session or operator app token.
 *
 * Session writes user_enabled; app token (transitional) writes operator_enabled.
 */
export async function handlePutEnabled(
  logIdSegment: string,
  request: Request,
  env: Env,
): Promise<Response> {
  try {
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

    const sessionToken = parseBearerSession(request);
    const useUserAuthority =
      sessionToken !== null && walletChallengeEnabled(env);

    if (useUserAuthority) {
      const authErr = requireUserSessionOrResponse(request, env, {
        scope: "logs:enabled:write",
        logIdHex32,
      });
      if (authErr) return authErr;

      return forwardToStore(env, logIdHex32, `/enabled/${logIdHex32}/user`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    }

    const authErr = requireOperatorTokenOrAppTokenOrResponse(request, env);
    if (authErr) return authErr;

    return forwardToStore(env, logIdHex32, `/enabled/${logIdHex32}/operator`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (error) {
    return internalError(error);
  }
}
