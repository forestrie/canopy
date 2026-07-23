import { describe, it, expect } from "vitest";
import { generateCdpJwt, facilitatorRequiresAuth } from "../src/cdp-jwt.js";

// Build a CDP-shaped Ed25519 secret: base64 of seed(32)||publicKey(32), and
// return the raw public key so a test can verify the JWT signature the way CDP
// would. This mirrors how a real CDP_API_KEY_SECRET is structured.
async function makeCdpSecret(): Promise<{ b64: string; publicKey: CryptoKey }> {
  const kp = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const pkcs8 = new Uint8Array(
    (await crypto.subtle.exportKey("pkcs8", kp.privateKey)) as ArrayBuffer,
  );
  const seed = pkcs8.slice(pkcs8.length - 32); // last 32 bytes of PKCS#8 = seed
  const pub = new Uint8Array(
    (await crypto.subtle.exportKey("raw", kp.publicKey)) as ArrayBuffer,
  );
  const secret = new Uint8Array(64);
  secret.set(seed, 0);
  secret.set(pub, 32);
  const b64 = btoa(String.fromCharCode(...secret));
  return { b64, publicKey: kp.publicKey };
}

function b64urlToBytes(s: string): Uint8Array {
  const b64 = s
    .replace(/-/g, "+")
    .replace(/_/g, "/")
    .padEnd(s.length + ((4 - (s.length % 4)) % 4), "=");
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

describe("facilitatorRequiresAuth", () => {
  it("requires auth only for the CDP facilitator host", () => {
    expect(
      facilitatorRequiresAuth("https://api.cdp.coinbase.com/platform/v2/x402"),
    ).toBe(true);
    expect(facilitatorRequiresAuth("https://x402.org/facilitator")).toBe(false);
    expect(facilitatorRequiresAuth("not a url")).toBe(false);
  });
});

describe("generateCdpJwt (EdDSA)", () => {
  it("produces a JWT whose signature verifies against the key's own public half", async () => {
    const { b64, publicKey } = await makeCdpSecret();
    const jwt = await generateCdpJwt(
      "11111111-2222-3333-4444-555555555555",
      b64,
      "POST api.cdp.coinbase.com/platform/v2/x402/settle",
    );

    const [h, p, s] = jwt.split(".");
    expect(h && p && s).toBeTruthy();

    // Header is EdDSA, carries the key id and a hex nonce.
    const header = JSON.parse(new TextDecoder().decode(b64urlToBytes(h)));
    expect(header.alg).toBe("EdDSA");
    expect(header.typ).toBe("JWT");
    expect(header.kid).toBe("11111111-2222-3333-4444-555555555555");
    expect(header.nonce).toMatch(/^[0-9a-f]{32}$/);

    // Claims are the CDP shape.
    const claims = JSON.parse(new TextDecoder().decode(b64urlToBytes(p)));
    expect(claims.iss).toBe("cdp");
    expect(claims.sub).toBe("11111111-2222-3333-4444-555555555555");
    expect(claims.uri).toBe(
      "POST api.cdp.coinbase.com/platform/v2/x402/settle",
    );
    expect(claims.exp - claims.nbf).toBe(120);

    // The signature must verify over `${header}.${payload}` with the embedded
    // public key — this is the exact check CDP performs.
    const ok = await crypto.subtle.verify(
      { name: "Ed25519" },
      publicKey,
      b64urlToBytes(s),
      new TextEncoder().encode(`${h}.${p}`),
    );
    expect(ok).toBe(true);
  });

  it("rejects a legacy ECDSA / non-64-byte secret with a clear error", async () => {
    // A 32-byte-only base64 (e.g. a raw seed) is not the CDP 64-byte layout.
    const short = btoa(String.fromCharCode(...new Uint8Array(32)));
    await expect(generateCdpJwt("id", short, "POST host/path")).rejects.toThrow(
      /64-byte Ed25519|not supported/,
    );
  });
});
