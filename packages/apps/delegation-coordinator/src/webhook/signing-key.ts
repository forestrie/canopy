import type { Env } from "../env.js";
import { sha256Hex } from "../certificate-key.js";

export interface WebhookSigningKeyInfo {
  kid: string;
  alg: "ES256";
  publicKeyJwk: JsonWebKey;
}

let cachedPrivateKey: CryptoKey | null = null;
let cachedPublicInfo: WebhookSigningKeyInfo | null = null;

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

/** Test-only: reset in-memory key cache between isolated test files. */
export function resetSigningKeyCacheForTests(): void {
  cachedPrivateKey = null;
  cachedPublicInfo = null;
}
