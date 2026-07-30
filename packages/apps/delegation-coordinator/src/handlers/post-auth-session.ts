/**
 * POST /api/auth/session — verify signed envelope and mint session token.
 *
 * Binds signer to stored public root (ES256 or KS256) before HMAC mint.
 */

import type { Env } from "../env.js";
import { consumeWalletChallengeNonce } from "../auth/wallet-challenge/nonce-client.js";
import { coordinatorOrigin } from "../auth/coordinator-origin.js";
import {
  es256PublicKeyMatchesRoot,
  loadRegisteredPublicRoot,
} from "../auth/wallet-challenge/public-root-match.js";
import { mintSessionToken } from "../auth/wallet-challenge/session-token.js";
import { verifyEs256ControlPlaneSignature } from "../auth/wallet-challenge/verify-es256.js";
import { verifyKs256ControlPlaneSignatureForRoot } from "../auth/wallet-challenge/verify-ks256.js";
import { createErc1271VerifyHooks } from "@forestrie/chain-rpc";
import { normalizeLogIdToHex32 } from "../log-id.js";
import type { SessionExchangeRequest } from "../types/wallet-challenge.js";
import { base64ToBytes } from "../encoding.js";
import { internalError, problemResponse } from "./handler.js";

/** True when wallet-challenge routes are enabled. */
function walletChallengeEnabled(env: Env): boolean {
  return env.ENABLE_WALLET_CHALLENGE?.trim().toLowerCase() === "true";
}

/** Exchange signed wcc-1 envelope for HMAC session bearer token. */
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
      return problemResponse(
        400,
        "about:blank",
        "Invalid request",
        "Unsupported envelope version",
      );
    }

    const now = Date.now();
    if (envelope.expiresAt < now) {
      return problemResponse(
        400,
        "about:blank",
        "Invalid request",
        "Challenge expired",
      );
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
      if (!body.publicKeyX?.trim() || !body.publicKeyY?.trim()) {
        return problemResponse(
          400,
          "about:blank",
          "Invalid request",
          "publicKeyX and publicKeyY are required for ES256",
        );
      }
      let signerX: Uint8Array;
      let signerY: Uint8Array;
      try {
        signerX = base64ToBytes(body.publicKeyX);
        signerY = base64ToBytes(body.publicKeyY);
      } catch {
        return problemResponse(
          400,
          "about:blank",
          "Invalid request",
          "publicKeyX and publicKeyY must be valid base64",
        );
      }

      const verified = await verifyEs256ControlPlaneSignature(
        envelope,
        signature,
        signerX,
        signerY,
      );
      if (!verified) {
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
      if (root.alg !== "ES256") {
        return problemResponse(
          403,
          "about:blank",
          "Forbidden",
          "Registered publicRoot alg does not match ES256 challenge",
        );
      }
      if (!es256PublicKeyMatchesRoot(signerX, signerY, root.x, root.y)) {
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
    }

    if (alg !== "KS256") {
      return problemResponse(
        400,
        "about:blank",
        "Invalid request",
        "Unsupported alg",
      );
    }

    // Root first: contract-account roots (Safe 1x1 Mode D) dispatch to
    // ERC-1271 with the EIP-191 challenge digest instead of personal_sign
    // recovery (plan-2607-04 R1 / FOR-505).
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

    // STRICT hooks here (not the swallowing cert-verify wrapper): an RPC
    // outage must surface as 503, never collapse into a 403 verdict.
    const rpcUrl = env.KS256_RPC_URL?.trim();
    const verdict = await verifyKs256ControlPlaneSignatureForRoot(
      envelope,
      signature,
      root.key,
      rpcUrl ? createErc1271VerifyHooks([rpcUrl]) : undefined,
    );
    if (verdict === "unavailable") {
      return problemResponse(
        503,
        "about:blank",
        "Service Unavailable",
        "ERC-1271 root verification is unavailable — retry",
      );
    }
    if (verdict === "invalid_signature") {
      return problemResponse(
        401,
        "about:blank",
        "Unauthorized",
        "Invalid challenge signature",
      );
    }
    if (verdict !== "valid") {
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
