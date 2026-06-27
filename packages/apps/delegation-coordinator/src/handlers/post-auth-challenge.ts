/**
 * POST /api/auth/challenge — issue wallet-challenge nonce (wcc-1).
 *
 * Stores nonce in {@link WalletChallengeNonceDO} for later session exchange.
 */

import type { Env } from "../env.js";
import { issueWalletChallengeNonce } from "../auth/wallet-challenge/nonce-client.js";
import { isControlPlaneScope } from "../types/control-plane-scope.js";
import type {
  ChallengeRequest,
  ChallengeResponse,
} from "../types/wallet-challenge.js";
import { normalizeLogIdToHex32 } from "../log-id.js";
import { internalError, problemResponse } from "./handler.js";

/** Challenge envelope TTL in milliseconds. */
const CHALLENGE_TTL_MS = 120_000;

/** True when wallet-challenge routes are enabled. */
function walletChallengeEnabled(env: Env): boolean {
  return env.ENABLE_WALLET_CHALLENGE?.trim().toLowerCase() === "true";
}

/** Resolve coordinator origin for challenge response (local duplicate). */
function coordinatorOrigin(env: Env, request: Request): string {
  const configured = env.COORDINATOR_PUBLIC_URL?.trim();
  if (configured) return configured.replace(/\/$/, "");
  return new URL(request.url).origin;
}

/** Issue wcc-1 challenge JSON with fresh nonce. */
export async function handlePostAuthChallenge(
  request: Request,
  env: Env,
): Promise<Response> {
  try {
    if (!walletChallengeEnabled(env)) {
      return problemResponse(
        501,
        "about:blank",
        "Not Implemented",
        "Wallet challenge is disabled",
      );
    }

    const body = (await request.json()) as ChallengeRequest;
    if (
      !body.authLogId ||
      !Array.isArray(body.scopes) ||
      body.scopes.length === 0
    ) {
      return problemResponse(
        400,
        "about:blank",
        "Invalid request",
        "authLogId and non-empty scopes are required",
      );
    }

    for (const scope of body.scopes) {
      if (!isControlPlaneScope(scope)) {
        return problemResponse(
          400,
          "about:blank",
          "Invalid request",
          `Unknown scope: ${scope}`,
        );
      }
    }

    let authLogIdHex32: string;
    try {
      authLogIdHex32 = normalizeLogIdToHex32(body.authLogId);
    } catch (error) {
      return problemResponse(
        400,
        "about:blank",
        "Invalid request",
        error instanceof Error ? error.message : "Invalid authLogId",
      );
    }

    const issuedAt = Date.now();
    const expiresAt = issuedAt + CHALLENGE_TTL_MS;
    const { nonce } = await issueWalletChallengeNonce(env, {
      authLogIdHex32,
      scopes: body.scopes,
      expiresAt,
    });

    const domain = env.COORDINATOR_DOMAIN?.trim() || "forestrie.dev";
    const response: ChallengeResponse = {
      version: "wcc-1",
      nonce,
      authLogId: authLogIdHex32,
      scopes: body.scopes,
      issuedAt,
      expiresAt,
      domain,
      coordinatorOrigin: coordinatorOrigin(env, request),
    };
    return Response.json(response);
  } catch (error) {
    return internalError(error);
  }
}
