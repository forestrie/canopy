/**
 * CDP facilitator authentication.
 *
 * Two facilitators are in play (see docs/workers-environments.md):
 *
 *   - The public testnet facilitator https://x402.org/facilitator requires NO
 *     authentication. Callers gate on `facilitatorRequiresAuth()` and skip the
 *     JWT (and the credential requirement) entirely.
 *   - The Coinbase CDP facilitator https://api.cdp.coinbase.com/platform/v2/x402
 *     requires a JWT bearer signed with a CDP Secret API Key.
 *
 * As of February 2025 CDP issues Secret API Keys as **Ed25519** (EdDSA), and no
 * longer offers ECDSA for new keys. The key is a UUID id plus a base64 secret
 * that decodes to 64 bytes = seed(32) || publicKey(32); we sign with the seed
 * half. (This worker previously signed ES256 against a PKCS#8-ECDSA import while
 * reading env vars that held an Ed25519 key — it could never authenticate. FOR-79.)
 */

const CDP_FACILITATOR_HOST = "api.cdp.coinbase.com";

/**
 * Whether a facilitator URL needs a CDP JWT. Only the CDP-hosted facilitator
 * does; the credential-free testnet facilitator (x402.org) and anything else do
 * not, so the worker can settle on testnet with no CDP credentials at all.
 */
export function facilitatorRequiresAuth(facilitatorUrl: string): boolean {
  try {
    return new URL(facilitatorUrl).host === CDP_FACILITATOR_HOST;
  } catch {
    return false;
  }
}

const base64UrlEncode = (data: Uint8Array): string =>
  btoa(String.fromCharCode(...data))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

// RFC 8410 PKCS#8 prefix for an Ed25519 private key: SEQUENCE, version 0,
// AlgorithmIdentifier { 1.3.101.112 }, OCTET STRING wrapping the 32-byte seed.
// WebCrypto has no "raw" import for Ed25519 private keys, so we wrap the seed.
const PKCS8_ED25519_PREFIX = new Uint8Array([
  0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04,
  0x22, 0x04, 0x20,
]);

/**
 * Import a CDP Ed25519 signing key from its base64 secret (seed||publicKey).
 * Fails loudly on anything that is not 64 bytes — in particular a legacy ECDSA
 * key — rather than silently producing an unusable key.
 */
async function importCdpEd25519Key(keySecret: string): Promise<CryptoKey> {
  const raw = Uint8Array.from(atob(keySecret.trim()), (c) => c.charCodeAt(0));
  if (raw.length !== 64) {
    throw new Error(
      `CDP_API_KEY_SECRET must be a base64 64-byte Ed25519 seed||publicKey ` +
        `(decoded ${raw.length} bytes). Legacy ECDSA keys are not supported — ` +
        `issue an Ed25519 CDP Secret API Key.`,
    );
  }
  const pkcs8 = new Uint8Array(PKCS8_ED25519_PREFIX.length + 32);
  pkcs8.set(PKCS8_ED25519_PREFIX, 0);
  pkcs8.set(raw.subarray(0, 32), PKCS8_ED25519_PREFIX.length);
  return crypto.subtle.importKey(
    "pkcs8",
    pkcs8.buffer as ArrayBuffer,
    { name: "Ed25519" },
    false,
    ["sign"],
  );
}

function randomNonceHex(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Generate a CDP API JWT (EdDSA) for the `Authorization: Bearer` header.
 *
 * @param keyId   CDP Secret API Key id (UUID)
 * @param keySecret base64 secret (64-byte Ed25519 seed||publicKey)
 * @param uri     "METHOD host/path", e.g. "POST api.cdp.coinbase.com/platform/v2/x402/settle"
 */
export async function generateCdpJwt(
  keyId: string,
  keySecret: string,
  uri: string,
): Promise<string> {
  const header = {
    alg: "EdDSA",
    kid: keyId,
    typ: "JWT",
    nonce: randomNonceHex(),
  };

  const now = Math.floor(Date.now() / 1000);
  const payload = {
    sub: keyId,
    iss: "cdp",
    nbf: now,
    exp: now + 120,
    uri,
  };

  const enc = (obj: unknown): string =>
    base64UrlEncode(new TextEncoder().encode(JSON.stringify(obj)));

  const message = `${enc(header)}.${enc(payload)}`;
  const key = await importCdpEd25519Key(keySecret);
  const signature = await crypto.subtle.sign(
    { name: "Ed25519" },
    key,
    new TextEncoder().encode(message),
  );

  return `${message}.${base64UrlEncode(new Uint8Array(signature))}`;
}
