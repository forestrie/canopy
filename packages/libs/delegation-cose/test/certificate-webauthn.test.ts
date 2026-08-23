/**
 * ES256_WEBAUTHN delegation certificate builder (devdocs ADR-0063,
 * plan-2608-13 phase 2). A synthetic WebCrypto P-256 authenticator drives the
 * assertion-callback seam; the assembled certificate must verify through the
 * encoding envelope branch (the sole off-chain chokepoint) and must never
 * pass a plain ES256 verify.
 */

import { describe, expect, it } from "vitest";
import {
  base64UrlEncode,
  verifyCoseSign1WithParsedKey,
} from "@forestrie/encoding";
import {
  buildDelegationCertificateWebauthn,
  buildDelegationToBeSignedWebauthn,
  deriveEs256KidFromPublicKey,
  encodeIntKeyCbor,
  normalizeEs256SignatureLowS,
  parseDelegationCertificate,
  verifyDelegationCertificateEs256,
  type WebauthnAssertionResult,
} from "../src/index.js";

const LOG_ID_HEX32 = "101112131415161718191a1b1c1d1e1f";

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
}

async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(
    await crypto.subtle.digest("SHA-256", toArrayBuffer(bytes)),
  );
}

function delegatedCoseKey(seed: number): Uint8Array {
  const x = new Uint8Array(32);
  const y = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    x[i] = (seed + i) & 0xff;
    y[i] = (seed + 100 + i) & 0xff;
  }
  return encodeIntKeyCbor(
    new Map<number, unknown>([
      [1, 2],
      [-1, 1],
      [-2, x],
      [-3, y],
    ]),
  );
}

/** WebCrypto-backed synthetic authenticator (forge-style construction). */
function syntheticAuthenticator(
  keyPair: CryptoKeyPair,
  opts?: { uv?: boolean; corruptChallenge?: boolean },
): (challenge: Uint8Array) => Promise<WebauthnAssertionResult> {
  return async (challenge) => {
    const challengeB64 = base64UrlEncode(
      opts?.corruptChallenge ? new Uint8Array(32).fill(0x5a) : challenge,
    );
    const clientDataJSON = new TextEncoder().encode(
      `{"type":"webauthn.get","challenge":"${challengeB64}","origin":"https://thinker.example","crossOrigin":false}`,
    );
    const authenticatorData = new Uint8Array(37);
    authenticatorData.set(
      await sha256(new TextEncoder().encode("thinker.example")),
      0,
    );
    authenticatorData[32] = opts?.uv === false ? 0x01 : 0x05; // UP (| UV)
    const signedBytes = new Uint8Array(37 + 32);
    signedBytes.set(authenticatorData, 0);
    signedBytes.set(await sha256(clientDataJSON), 37);
    const signature = normalizeEs256SignatureLowS(
      new Uint8Array(
        await crypto.subtle.sign(
          { name: "ECDSA", hash: "SHA-256" },
          keyPair.privateKey,
          toArrayBuffer(signedBytes),
        ),
      ),
    );
    return { authenticatorData, clientDataJSON, signature };
  };
}

async function rootKeyPair(): Promise<CryptoKeyPair> {
  return (await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
}

async function rootXy(
  keyPair: CryptoKeyPair,
): Promise<{ x: Uint8Array; y: Uint8Array }> {
  const raw = new Uint8Array(
    await crypto.subtle.exportKey("raw", keyPair.publicKey),
  );
  return { x: raw.slice(1, 33), y: raw.slice(33, 65) };
}

describe("buildDelegationCertificateWebauthn", () => {
  const input = {
    logIdHex32: LOG_ID_HEX32,
    mmrStart: 0,
    mmrEnd: 16383,
    issuedAt: 1_700_000_000,
    expiresAt: 4_102_444_800,
  };

  it("assembles a certificate the encoding envelope branch verifies", async () => {
    const root = await rootKeyPair();
    const kid = await deriveEs256KidFromPublicKey(root.publicKey);
    const delegatedPublicKeyCbor = delegatedCoseKey(5);
    const certificate = await buildDelegationCertificateWebauthn(
      { ...input, delegatedPublicKeyCbor },
      kid,
      syntheticAuthenticator(root),
    );
    const { x, y } = await rootXy(root);
    expect(
      await verifyCoseSign1WithParsedKey(certificate, {
        x,
        y,
        curve: "P-256",
      }),
    ).toBe(true);
    // UV was set by the synthetic authenticator, so the grant-in-evidence
    // verifier path passes too.
    expect(
      await verifyCoseSign1WithParsedKey(
        certificate,
        { x, y, curve: "P-256" },
        { requireUserVerification: true },
      ),
    ).toBe(true);

    const info = parseDelegationCertificate(certificate);
    expect(info.logIdHex32).toBe(LOG_ID_HEX32);
    expect(info.mmrStart).toBe(0);
    expect(info.mmrEnd).toBe(16383);
    expect(info.issuedAt).toBe(input.issuedAt);
    expect(info.expiresAt).toBe(input.expiresAt);
  });

  it("never passes a plain ES256 verify (fail-closed, distinct alg)", async () => {
    const root = await rootKeyPair();
    const kid = await deriveEs256KidFromPublicKey(root.publicKey);
    const certificate = await buildDelegationCertificateWebauthn(
      { ...input, delegatedPublicKeyCbor: delegatedCoseKey(7) },
      kid,
      syntheticAuthenticator(root),
    );
    expect(
      await verifyDelegationCertificateEs256(certificate, root.publicKey),
    ).toBe(false);
  });

  it("fails verification when the assertion challenge is not bound", async () => {
    const root = await rootKeyPair();
    const kid = await deriveEs256KidFromPublicKey(root.publicKey);
    const certificate = await buildDelegationCertificateWebauthn(
      { ...input, delegatedPublicKeyCbor: delegatedCoseKey(9) },
      kid,
      syntheticAuthenticator(root, { corruptChallenge: true }),
    );
    const { x, y } = await rootXy(root);
    expect(
      await verifyCoseSign1WithParsedKey(certificate, {
        x,
        y,
        curve: "P-256",
      }),
    ).toBe(false);
  });

  it("fails a UV-required verify when the assertion carries UP only", async () => {
    const root = await rootKeyPair();
    const kid = await deriveEs256KidFromPublicKey(root.publicKey);
    const certificate = await buildDelegationCertificateWebauthn(
      { ...input, delegatedPublicKeyCbor: delegatedCoseKey(11) },
      kid,
      syntheticAuthenticator(root, { uv: false }),
    );
    const { x, y } = await rootXy(root);
    expect(
      await verifyCoseSign1WithParsedKey(certificate, {
        x,
        y,
        curve: "P-256",
      }),
    ).toBe(true);
    expect(
      await verifyCoseSign1WithParsedKey(
        certificate,
        { x, y, curve: "P-256" },
        { requireUserVerification: true },
      ),
    ).toBe(false);
  });

  it("derives the challenge from the certificate Sig_structure (ADR-0063 §3)", async () => {
    const root = await rootKeyPair();
    const kid = await deriveEs256KidFromPublicKey(root.publicKey);
    let seen: Uint8Array | undefined;
    const delegatedPublicKeyCbor = delegatedCoseKey(13);
    const inner = syntheticAuthenticator(root);
    await buildDelegationCertificateWebauthn(
      { ...input, delegatedPublicKeyCbor, delegationId: new Uint8Array(16) },
      kid,
      async (challenge) => {
        seen = challenge;
        return inner(challenge);
      },
    );
    const tbs = buildDelegationToBeSignedWebauthn(
      { ...input, delegatedPublicKeyCbor, delegationId: new Uint8Array(16) },
      kid,
    );
    expect(Array.from(seen!)).toEqual(
      Array.from(await sha256(tbs.sigStructureBytes)),
    );
  });
});
