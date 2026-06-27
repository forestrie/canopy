/**
 * Authorization gates for user (/api/) and operator (/admin/api/) routes.
 *
 * User routes accept wallet-challenge session tokens (wcc-1) or fall back to
 * {@link Env.COORDINATOR_APP_TOKEN} when challenge is disabled. Operator routes
 * require the app token only. Session scopes map to control-plane capabilities
 * per [ARC-0017](https://github.com/forestrie/devdocs/blob/main/arc/arc-0017-hierarchical-authority-logs-and-fee-distribution.md).
 */

import type { Env } from "../env.js";
import { coordinatorOrigin } from "./coordinator-origin.js";
import { checkBearerToken } from "./check-bearer-token.js";
import { scopeAllows } from "./wallet-challenge/scopes.js";
import {
  parseBearerSession,
  verifySessionToken,
} from "./wallet-challenge/session-token.js";
import type { SessionTokenClaims } from "../types/wallet-challenge.js";
import type { ControlPlaneScope } from "../types/control-plane-scope.js";
import { problemResponse } from "../handlers/handler.js";

/** Options for {@link requireUserSessionOrResponse}. */
export interface RequireUserSessionOptions {
  /** Required scope for the target route. */
  scope: ControlPlaneScope;
  /** When set, session authLogId must match this value. */
  authLogIdHex32?: string;
  /** When set, session authLogId must match the target log id. */
  logIdHex32?: string;
}

/** True when wallet-challenge auth endpoints are enabled. */
function walletChallengeEnabled(env: Env): boolean {
  return env.ENABLE_WALLET_CHALLENGE?.trim().toLowerCase() === "true";
}

/**
 * Verify session token claims bind to requested log ids.
 *
 * @param session - Verified session claims.
 * @param opts - Optional authLogId / logIdHex32 binding requirements.
 * @returns 403 Response on mismatch, otherwise null.
 */
function bindLogIds(
  session: SessionTokenClaims,
  opts: RequireUserSessionOptions,
): Response | null {
  if (opts.authLogIdHex32 && session.authLogId !== opts.authLogIdHex32) {
    return problemResponse(
      403,
      "about:blank",
      "Forbidden",
      "session authLogId does not match request",
    );
  }
  if (opts.logIdHex32 && session.authLogId !== opts.logIdHex32) {
    return problemResponse(
      403,
      "about:blank",
      "Forbidden",
      "session authLogId does not match target logId",
    );
  }
  return null;
}

/**
 * Require a wallet-challenge control-plane session on /api/ user routes.
 *
 * When wallet challenge is disabled, falls back to
 * {@link Env.COORDINATOR_APP_TOKEN}.
 *
 * @param request - Incoming HTTP request.
 * @param env - Worker bindings.
 * @param opts - Required scope and optional log id binding.
 * @returns null when authorized, otherwise an error Response.
 */
export function requireUserSessionOrResponse(
  request: Request,
  env: Env,
  opts: RequireUserSessionOptions,
): Response | null {
  const sessionToken = parseBearerSession(request);
  const secret = env.WALLET_CHALLENGE_SIGNING_SECRET?.trim();

  if (sessionToken && secret && walletChallengeEnabled(env)) {
    const expectedAud = coordinatorOrigin(env, request);
    const claims = verifySessionToken(
      sessionToken,
      secret,
      undefined,
      expectedAud,
    );
    if (!claims) {
      return problemResponse(
        401,
        "about:blank",
        "Unauthorized",
        "Invalid or expired control-plane session",
      );
    }
    if (!scopeAllows(claims.scopes, opts.scope)) {
      return problemResponse(
        403,
        "about:blank",
        "Forbidden",
        `Missing scope ${opts.scope}`,
      );
    }
    const bindErr = bindLogIds(claims, opts);
    if (bindErr) return bindErr;
    return null;
  }

  if (walletChallengeEnabled(env)) {
    return problemResponse(
      401,
      "about:blank",
      "Unauthorized",
      "Control-plane session required for this endpoint",
    );
  }

  return checkBearerToken(request, env.COORDINATOR_APP_TOKEN);
}

/**
 * Require {@link Env.COORDINATOR_APP_TOKEN} on /admin/api/ operator routes.
 *
 * Rejects wallet-challenge sessions when challenge mode is enabled.
 *
 * @param request - Incoming HTTP request.
 * @param env - Worker bindings.
 * @returns null when authorized, otherwise an error Response.
 */
export function requireOperatorTokenOrResponse(
  request: Request,
  env: Env,
): Response | null {
  const sessionToken = parseBearerSession(request);
  if (sessionToken && walletChallengeEnabled(env)) {
    return problemResponse(
      401,
      "about:blank",
      "Unauthorized",
      "Operator token required for this endpoint",
    );
  }
  return checkBearerToken(request, env.COORDINATOR_APP_TOKEN);
}

/**
 * Transitional gate: operator token on /api/ enabled PUT (operator_enabled).
 *
 * Accepts operator token only (not wallet sessions).
 *
 * @param request - Incoming HTTP request.
 * @param env - Worker bindings.
 * @returns null when authorized, otherwise an error Response.
 */
export function requireOperatorTokenOrAppTokenOrResponse(
  request: Request,
  env: Env,
): Response | null {
  const sessionToken = parseBearerSession(request);
  if (sessionToken && walletChallengeEnabled(env)) {
    return problemResponse(
      401,
      "about:blank",
      "Unauthorized",
      "Operator token required for this endpoint",
    );
  }
  return checkBearerToken(request, env.COORDINATOR_APP_TOKEN);
}
