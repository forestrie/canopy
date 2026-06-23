import { hmac } from "@noble/hashes/hmac";
import { sha256 } from "@noble/hashes/sha2";
import { bytesToBase64Url, base64UrlToBytes } from "../../encoding.js";
import type { ControlPlaneScope } from "../../types/control-plane-scope.js";
import type { SessionTokenClaims } from "../../types/wallet-challenge.js";

const SESSION_VERSION = 1;
const SESSION_TTL_SEC = 600;

function signingKey(secret: string): Uint8Array {
  return new TextEncoder().encode(secret);
}

export function sessionExpiresAt(
  nowSec = Math.floor(Date.now() / 1000),
): number {
  return nowSec + SESSION_TTL_SEC;
}

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

export function parseBearerSession(request: Request): string | null {
  const auth = request.headers.get("Authorization")?.trim() ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(auth);
  if (!match) return null;
  const token = match[1]!.trim();
  if (!token.startsWith("v1.")) return null;
  return token;
}
