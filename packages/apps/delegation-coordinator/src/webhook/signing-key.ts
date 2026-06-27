/**
 * ES256 webhook signing key load, JWKS metadata, and signature production.
 *
 * Signs `delegation.required` payloads for operator subscribers. Private key
 * from Secrets Store or dev PEM; public JWK exposed at webhook JWKS route.
 */

import type { Env } from "../env.js";
import { sha256Hex } from "../certificate-key.js";

/** Public metadata for webhook signature verification (JWKS). */
export interface WebhookSigningKeyInfo {
  kid: string;
  alg: "ES256";
  publicKeyJwk: JsonWebKey;
}

/** In-process cache of imported private signing key. */
let cachedPrivateKey: CryptoKey | null = null;

/** In-process cache of derived public JWKS info. */
let cachedPublicInfo: WebhookSigningKeyInfo | null = null;

/** Strip PEM armor and decode PKCS#8 body to bytes. */
function pemToPkcs8Bytes(pem: string): Uint8Array {
  const body = pem
    .replace(/-----BEGIN PRIVATE KEY-----/g, "")
    .replace(/-----END PRIVATE KEY-----/g, "")
    .replace(/\s/g, "");
  const binary = atob(body);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}

/** Base64url-encode raw bytes without padding. */
function base64UrlEncode(data: Uint8Array): string {
  let binary = "";
  for (const byte of data) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

/**
 * Resolve PKCS#8 PEM from Secrets Store or dev fallback.
 *
 * @param env - Worker bindings.
 * @returns PEM string for ES256 private key import.
 * @throws When neither WEBHOOK_SIGNING_KEY nor WEBHOOK_SIGNING_KEY_PEM is set.
 */
async function resolveSigningKeyPem(env: Env): Promise<string> {
  if (env.WEBHOOK_SIGNING_KEY) {
    return env.WEBHOOK_SIGNING_KEY.get();
  }
  const pem = env.WEBHOOK_SIGNING_KEY_PEM?.trim();
  if (pem) return pem;
  throw new Error(
    "WEBHOOK_SIGNING_KEY (Secrets Store) or WEBHOOK_SIGNING_KEY_PEM is required",
  );
}

/**
 * Import and cache the webhook ES256 private key.
 *
 * @param env - Worker bindings.
 * @returns WebCrypto signing key.
 */
export async function loadSigningKey(env: Env): Promise<CryptoKey> {
  if (cachedPrivateKey) return cachedPrivateKey;
  const pem = await resolveSigningKeyPem(env);
  cachedPrivateKey = await crypto.subtle.importKey(
    "pkcs8",
    pemToPkcs8Bytes(pem),
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign"],
  );
  return cachedPrivateKey;
}

/**
 * Derive public JWKS entry and key id from the signing key.
 *
 * @param env - Worker bindings.
 * @returns kid, alg, and public JWK for subscriber verification.
 */
export async function getWebhookSigningKeyInfo(
  env: Env,
): Promise<WebhookSigningKeyInfo> {
  if (cachedPublicInfo) return cachedPublicInfo;
  const privateKey = await loadSigningKey(env);
  const privateJwk = (await crypto.subtle.exportKey(
    "jwk",
    privateKey,
  )) as JsonWebKey & { d?: string };
  const { d: _d, ...publicPart } = privateJwk;
  const publicKeyJwk: JsonWebKey = {
    ...publicPart,
    kty: "EC",
    crv: "P-256",
    alg: "ES256",
    key_ops: ["verify"],
  };
  const kid = (
    await sha256Hex(
      new TextEncoder().encode(
        `${publicKeyJwk.x ?? ""}:${publicKeyJwk.y ?? ""}`,
      ),
    )
  ).slice(0, 16);
  cachedPublicInfo = { kid, alg: "ES256", publicKeyJwk };
  return cachedPublicInfo;
}

/**
 * Produce X-Forestrie-Webhook-Signature for a payload.
 *
 * @param env - Worker bindings.
 * @param timestamp - Unix seconds string (header value).
 * @param rawBody - Exact JSON body bytes as string.
 * @returns Base64url ECDSA signature over `timestamp.rawBody`.
 */
export async function signWebhook(
  env: Env,
  timestamp: string,
  rawBody: string,
): Promise<string> {
  const key = await loadSigningKey(env);
  const message = new TextEncoder().encode(`${timestamp}.${rawBody}`);
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    message,
  );
  return base64UrlEncode(new Uint8Array(signature));
}

/** Reset in-memory key cache between isolated test files. */
export function resetSigningKeyCacheForTests(): void {
  cachedPrivateKey = null;
  cachedPublicInfo = null;
}
