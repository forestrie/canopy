/**
 * POST /api/auth/session — verify signed envelope and mint control-plane session.
 */

import type { Env } from "../env.js";
import { consumeWalletChallengeNonce } from "../auth/wallet-challenge/nonce-client.js";
import { coordinatorOrigin } from "../auth/coordinator-origin.js";
import {
  ks256AddressMatchesRoot,
  loadRegisteredPublicRoot,
} from "../auth/wallet-challenge/public-root-match.js";
import { mintSessionToken } from "../auth/wallet-challenge/session-token.js";
import { verifyKs256ControlPlaneSignature } from "../auth/wallet-challenge/verify-ks256.js";
import { normalizeLogIdToHex32 } from "../log-id.js";
import type { SessionExchangeRequest } from "../types/wallet-challenge.js";
import { internalError, problemResponse } from "./handler.js";

function walletChallengeEnabled(env: Env): boolean {
  return env.ENABLE_WALLET_CHALLENGE?.trim().toLowerCase() === "true";
}

export async function handlePostAuthSession(
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

    const secret = env.WALLET_CHALLENGE_SIGNING_SECRET?.trim();
    if (!secret) {
      return problemResponse(
        500,
        "about:blank",
        "Internal error",
        "WALLET_CHALLENGE_SIGNING_SECRET is not configured",
      );
    }

    const body = (await request.json()) as SessionExchangeRequest;
    const { envelope, signature, alg } = body;
    if (!envelope || !signature || !alg) {
      return problemResponse(
        400,
        "about:blank",
        "Invalid request",
        "envelope, signature, and alg are required",
      );
    }

    if (envelope.version !== "wcc-1") {
      return problemResponse(400, "about:blank", "Invalid request", "Unsupported envelope version");
    }

    const now = Date.now();
    if (envelope.expiresAt < now) {
      return problemResponse(400, "about:blank", "Invalid request", "Challenge expired");
    }

    const expectedOrigin = coordinatorOrigin(env, request);
    if (envelope.coordinatorOrigin !== expectedOrigin) {
      return problemResponse(
        400,
        "about:blank",
        "Invalid request",
        "coordinatorOrigin mismatch",
      );
    }

    let authLogIdHex32: string;
    try {
      authLogIdHex32 = normalizeLogIdToHex32(envelope.authLogId);
    } catch (error) {
      return problemResponse(
        400,
        "about:blank",
        "Invalid request",
        error instanceof Error ? error.message : "Invalid authLogId",
      );
    }

    const consumed = await consumeWalletChallengeNonce(env, {
      nonce: envelope.nonce,
      authLogIdHex32,
      scopes: envelope.scopes,
    });
    if (!consumed) {
      return problemResponse(
        401,
        "about:blank",
        "Unauthorized",
        "Invalid or consumed challenge nonce",
      );
    }

    if (alg === "ES256") {
      return problemResponse(
        501,
        "about:blank",
        "Not Implemented",
        "ES256 wallet challenge is not implemented yet",
      );
    }

    if (alg !== "KS256") {
      return problemResponse(400, "about:blank", "Invalid request", "Unsupported alg");
    }

    const recovered = await verifyKs256ControlPlaneSignature(envelope, signature);
    if (!recovered) {
      return problemResponse(
        401,
        "about:blank",
        "Unauthorized",
        "Invalid challenge signature",
      );
    }

    const root = await loadRegisteredPublicRoot(env, authLogIdHex32);
    if (!root) {
      return problemResponse(
        403,
        "about:blank",
        "Forbidden",
        "No registered publicRoot for authLogId",
      );
    }
    if (root.alg !== "KS256") {
      return problemResponse(
        403,
        "about:blank",
        "Forbidden",
        "Registered publicRoot alg does not match KS256 challenge",
      );
    }
    if (!ks256AddressMatchesRoot(recovered, root.key)) {
      return problemResponse(
        403,
        "about:blank",
        "Forbidden",
        "Signer does not match registered publicRoot",
      );
    }

    const { token, expiresAt, claims } = mintSessionToken(
      {
        authLogId: authLogIdHex32,
        scopes: envelope.scopes,
        aud: expectedOrigin,
      },
      secret,
    );

    return Response.json({
      token,
      expiresAt,
      authLogId: claims.authLogId,
      scopes: claims.scopes,
    });
  } catch (error) {
    return internalError(error);
  }
}
