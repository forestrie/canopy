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

export interface RequireUserSessionOptions {
  scope: ControlPlaneScope;
  authLogIdHex32?: string;
  logIdHex32?: string;
}

function walletChallengeEnabled(env: Env): boolean {
  return env.ENABLE_WALLET_CHALLENGE?.trim().toLowerCase() === "true";
}

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
 * When wallet challenge is disabled, falls back to COORDINATOR_APP_TOKEN.
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
 * Require COORDINATOR_APP_TOKEN on /admin/api/ operator routes.
 * Rejects wallet-challenge sessions.
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
 * Transitional: app token on /api/ enabled PUT writes operator_enabled.
 * Accepts operator token only (not sessions).
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
