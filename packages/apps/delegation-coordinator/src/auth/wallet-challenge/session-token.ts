/**
 * HMAC session tokens minted after wallet-challenge signature verification.
 *
 * Short-lived bearer tokens authorize /api/ control-plane routes; audience
 * binds to {@link coordinatorOrigin}.
 */

import { hmac } from "@noble/hashes/hmac";
import { sha256 } from "@noble/hashes/sha2";
import { bytesToBase64Url, base64UrlToBytes } from "../../encoding.js";
import type { ControlPlaneScope } from "../../types/control-plane-scope.js";
import type { SessionTokenClaims } from "../../types/wallet-challenge.js";

/** Session token format version embedded in claims. */
const SESSION_VERSION = 1;

/** Default session lifetime in seconds after mint. */
const SESSION_TTL_SEC = 600;

/** Encode HMAC signing secret as UTF-8 bytes. */
function signingKey(secret: string): Uint8Array {
  return new TextEncoder().encode(secret);
}

/**
 * Compute default session expiry from current time.
 *
 * @param nowSec - Current Unix timestamp in seconds.
 */
export function sessionExpiresAt(
  nowSec = Math.floor(Date.now() / 1000),
): number {
  return nowSec + SESSION_TTL_SEC;
}

/**
 * Mint a v1 HMAC session token and signed string.
 *
 * @param claims - authLogId, scopes, aud; optional exp override.
 * @param secret - {@link Env.WALLET_CHALLENGE_SIGNING_SECRET}.
 * @param nowSec - Issuance time for default exp.
 * @returns Token string, expiry, and full claims.
 */
export function mintSessionToken(
  claims: Omit<SessionTokenClaims, "v" | "exp"> & { exp?: number },
  secret: string,
  nowSec = Math.floor(Date.now() / 1000),
): { token: string; expiresAt: number; claims: SessionTokenClaims } {
  const full: SessionTokenClaims = {
    v: SESSION_VERSION,
    authLogId: claims.authLogId,
    scopes: claims.scopes,
    aud: claims.aud,
    exp: claims.exp ?? sessionExpiresAt(nowSec),
  };
  const payload = bytesToBase64Url(
    new TextEncoder().encode(JSON.stringify(full)),
  );
  const sig = bytesToBase64Url(
    hmac(sha256, signingKey(secret), new TextEncoder().encode(`v1.${payload}`)),
  );
  return { token: `v1.${payload}.${sig}`, expiresAt: full.exp, claims: full };
}

/**
 * Verify a v1 session token signature, expiry, and optional audience.
 *
 * @param token - Full `v1.<payload>.<sig>` string.
 * @param secret - HMAC secret.
 * @param nowSec - Current time for exp check.
 * @param expectedAud - When set, aud claim must match.
 * @returns Parsed claims or null when invalid.
 */
export function verifySessionToken(
  token: string,
  secret: string,
  nowSec = Math.floor(Date.now() / 1000),
  expectedAud?: string,
): SessionTokenClaims | null {
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== "v1") return null;
  const payload = parts[1]!;
  const sig = parts[2]!;
  const expected = bytesToBase64Url(
    hmac(sha256, signingKey(secret), new TextEncoder().encode(`v1.${payload}`)),
  );
  if (sig.length !== expected.length) return null;
  let diff = 0;
  for (let i = 0; i < sig.length; i++) {
    diff |= sig.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  if (diff !== 0) return null;

  let claims: SessionTokenClaims;
  try {
    claims = JSON.parse(
      new TextDecoder().decode(base64UrlToBytes(payload)),
    ) as SessionTokenClaims;
  } catch {
    return null;
  }
  if (claims.v !== SESSION_VERSION) return null;
  if (!claims.authLogId || !Array.isArray(claims.scopes) || !claims.aud) {
    return null;
  }
  if (claims.exp <= nowSec) return null;
  if (expectedAud !== undefined && claims.aud !== expectedAud) return null;
  return claims;
}

/**
 * Extract a v1 session token from Authorization Bearer header.
 *
 * @param request - Incoming HTTP request.
 * @returns Token string or null when not a session bearer.
 */
export function parseBearerSession(request: Request): string | null {
  const auth = request.headers.get("Authorization")?.trim() ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(auth);
  if (!match) return null;
  const token = match[1]!.trim();
  if (!token.startsWith("v1.")) return null;
  return token;
}
