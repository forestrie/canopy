/**
 * ES256_WEBAUTHN (-65800) certificate envelope verification (devdocs
 * ADR-0063, plan-2608-13 1.4). The unprotected header carries
 * `[authenticatorData, clientDataJSON]` at label -65800; the envelope is
 * unsigned, so trust hinges on `clientDataJSON.challenge ==
 * base64url(sha256(Sig_structure))`. Fail-closed both directions: under
 * -65800 a missing/unbound envelope fails (never a plain-verify fallback);
 * under any other alg a present envelope label is rejected.
 */

import { describe, expect, it } from "vitest";
import {
  COSE_ALG_ES256,
  COSE_ALG_ES256_WEBAUTHN,
  COSE_ALG_KS256,
  WEBAUTHN_ENVELOPE_LABEL,
  algToCurve,
  base64UrlEncode,
  verifyCoseSign1,
  verifyCoseSign1WithParsedKey,
} from "./index.js";
import { encodeCborDeterministic } from "./encode-cbor-deterministic.js";
import { encodeCoseSign1Raw } from "./encode-cose-sign1-raw.js";
import { encodeSigStructure } from "./encode-sig-structure.js";
import { mergeUnprotectedIntoCoseSign1 } from "./merge-cose-sign1-unprotected.js";

const FLAG_UP = 0x01;
const FLAG_UV = 0x04;
const FLAG_BS = 0x10;

const P256_N = BigInt(
  "0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551",
);

function toLowS(signature: Uint8Array): Uint8Array {
  let s = 0n;
  for (let i = 32; i < 64; i++) {
    s = (s << 8n) | BigInt(signature[i]!);
  }
  if (s <= P256_N >> 1n) return signature;
  s = P256_N - s;
  const out = new Uint8Array(64);
  out.set(signature.subarray(0, 32), 0);
  for (let i = 0; i < 32; i++) {
    out[63 - i] = Number((s >> BigInt(8 * i)) & 0xffn);
  }
  return out;
}

function toHighS(signature: Uint8Array): Uint8Array {
  const low = toLowS(signature);
  let s = 0n;
  for (let i = 32; i < 64; i++) {
    s = (s << 8n) | BigInt(low[i]!);
  }
  const sHigh = P256_N - s;
  const out = new Uint8Array(64);
  out.set(low.subarray(0, 32), 0);
  for (let i = 0; i < 32; i++) {
    out[63 - i] = Number((sHigh >> BigInt(8 * i)) & 0xffn);
  }
  return out;
}

async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(
    await crypto.subtle.digest("SHA-256", new Uint8Array(bytes)),
  );
}

async function generateKeyPair(): Promise<CryptoKeyPair> {
  return (await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
}

/** Synthetic WebAuthn-enveloped certificate signed by `root` (ADR-0063 §2). */
async function buildWebauthnCert(
  root: CryptoKeyPair,
  opts?: {
    flags?: number;
    ceremonyType?: string;
    /** Bind the challenge to these bytes instead of the real Sig_structure. */
    challengeFrom?: Uint8Array;
    omitEnvelope?: boolean;
    envelopeOverride?: unknown;
    highS?: boolean;
  },
): Promise<Uint8Array> {
  const protectedBstr = encodeCborDeterministic(
    new Map<number, unknown>([[1, COSE_ALG_ES256_WEBAUTHN]]),
  );
  const payload = new TextEncoder().encode("delegation certificate payload");
  const sigStructure = encodeSigStructure(
    protectedBstr,
    new Uint8Array(0),
    payload,
  );
  const challenge = base64UrlEncode(
    await sha256(opts?.challengeFrom ?? sigStructure),
  );
  const clientDataJSON = new TextEncoder().encode(
    `{"type":"${opts?.ceremonyType ?? "webauthn.get"}","challenge":"${challenge}","origin":"https://thinker.example","crossOrigin":false}`,
  );
  const authData = new Uint8Array(37);
  authData.fill(0xa1, 0, 32); // rpIdHash (unpinned)
  authData[32] = opts?.flags ?? FLAG_UP;

  const cdjHash = await sha256(clientDataJSON);
  const signedBytes = new Uint8Array(authData.length + 32);
  signedBytes.set(authData, 0);
  signedBytes.set(cdjHash, authData.length);
  let signature: Uint8Array = new Uint8Array(
    await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      root.privateKey,
      new Uint8Array(signedBytes),
    ),
  );
  signature = opts?.highS ? toHighS(signature) : toLowS(signature);

  const unprotected = new Map<number, unknown>();
  if (!opts?.omitEnvelope) {
    unprotected.set(
      WEBAUTHN_ENVELOPE_LABEL,
      opts?.envelopeOverride ?? [authData, clientDataJSON],
    );
  }
  return encodeCoseSign1Raw(protectedBstr, unprotected, payload, signature);
}

async function exportXy(
  publicKey: CryptoKey,
): Promise<{ x: Uint8Array; y: Uint8Array }> {
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", publicKey));
  return { x: raw.slice(1, 33), y: raw.slice(33, 65) };
}

describe("verifyCoseSign1WithParsedKey — ES256_WEBAUTHN envelope (ADR-0063)", () => {
  it("verifies a challenge-bound enveloped certificate (CryptoKey and coords)", async () => {
    const root = await generateKeyPair();
    const cert = await buildWebauthnCert(root);
    expect(await verifyCoseSign1WithParsedKey(cert, root.publicKey)).toBe(true);
    expect(await verifyCoseSign1(cert, root.publicKey)).toBe(true);
    const { x, y } = await exportXy(root.publicKey);
    expect(
      await verifyCoseSign1WithParsedKey(cert, { x, y, curve: "P-256" }),
    ).toBe(true);
  });

  it("rejects when signed by a different key", async () => {
    const root = await generateKeyPair();
    const other = await generateKeyPair();
    const cert = await buildWebauthnCert(other);
    expect(await verifyCoseSign1WithParsedKey(cert, root.publicKey)).toBe(
      false,
    );
  });

  it("rejects a challenge bound to different bytes (key possession only)", async () => {
    const root = await generateKeyPair();
    const cert = await buildWebauthnCert(root, {
      challengeFrom: new TextEncoder().encode("some-other-payload"),
    });
    expect(await verifyCoseSign1WithParsedKey(cert, root.publicKey)).toBe(
      false,
    );
  });

  it("rejects a registration ceremony (webauthn.create)", async () => {
    const root = await generateKeyPair();
    const cert = await buildWebauthnCert(root, {
      ceremonyType: "webauthn.create",
    });
    expect(await verifyCoseSign1WithParsedKey(cert, root.publicKey)).toBe(
      false,
    );
  });

  it("rejects missing user presence and BS-without-BE flag states", async () => {
    const root = await generateKeyPair();
    for (const flags of [FLAG_UV, FLAG_UP | FLAG_BS]) {
      const cert = await buildWebauthnCert(root, { flags });
      expect(await verifyCoseSign1WithParsedKey(cert, root.publicKey)).toBe(
        false,
      );
    }
  });

  it("enforces UV only when the caller requires it (grant-declared policy)", async () => {
    const root = await generateKeyPair();
    const upOnly = await buildWebauthnCert(root, { flags: FLAG_UP });
    const upUv = await buildWebauthnCert(root, { flags: FLAG_UP | FLAG_UV });
    expect(
      await verifyCoseSign1WithParsedKey(upOnly, root.publicKey, {
        requireUserVerification: true,
      }),
    ).toBe(false);
    expect(
      await verifyCoseSign1WithParsedKey(upUv, root.publicKey, {
        requireUserVerification: true,
      }),
    ).toBe(true);
    expect(await verifyCoseSign1WithParsedKey(upOnly, root.publicKey)).toBe(
      true,
    );
  });

  it("rejects under -65800 when the envelope is missing or malformed — never a plain-verify fallback", async () => {
    const root = await generateKeyPair();
    const missing = await buildWebauthnCert(root, { omitEnvelope: true });
    expect(await verifyCoseSign1WithParsedKey(missing, root.publicKey)).toBe(
      false,
    );
    for (const envelopeOverride of [
      [new Uint8Array(37)], // 1 element
      [new Uint8Array(37), new Uint8Array(2), new Uint8Array(1)], // 3 elements
      [new Uint8Array(36), new Uint8Array(2)], // authData < 37
      "not-an-array",
    ]) {
      const cert = await buildWebauthnCert(root, { envelopeOverride });
      expect(await verifyCoseSign1WithParsedKey(cert, root.publicKey)).toBe(
        false,
      );
    }
  });

  it("rejects the malleable high-s twin (canonical wire form)", async () => {
    const root = await generateKeyPair();
    const cert = await buildWebauthnCert(root, { highS: true });
    expect(await verifyCoseSign1WithParsedKey(cert, root.publicKey)).toBe(
      false,
    );
  });

  it("rejects an envelope label under ES256 — alg-specific material under an alg that defines none", async () => {
    // A valid plain ES256 statement acquires a stray -65800 unprotected
    // entry: mirror of on-chain UnexpectedDelegationAlgData, never ignored.
    const root = await generateKeyPair();
    const protectedBstr = encodeCborDeterministic(
      new Map<number, unknown>([[1, COSE_ALG_ES256]]),
    );
    const payload = new TextEncoder().encode("plain es256 payload");
    const sigStructure = encodeSigStructure(
      protectedBstr,
      new Uint8Array(0),
      payload,
    );
    const signature = new Uint8Array(
      await crypto.subtle.sign(
        { name: "ECDSA", hash: "SHA-256" },
        root.privateKey,
        new Uint8Array(sigStructure),
      ),
    );
    const plain = encodeCoseSign1Raw(
      protectedBstr,
      new Map(),
      payload,
      signature,
    );
    expect(await verifyCoseSign1WithParsedKey(plain, root.publicKey)).toBe(
      true,
    );
    const smuggled = mergeUnprotectedIntoCoseSign1(
      plain,
      new Map([[WEBAUTHN_ENVELOPE_LABEL, [new Uint8Array(37), payload]]]),
    );
    expect(await verifyCoseSign1WithParsedKey(smuggled, root.publicKey)).toBe(
      false,
    );
  });
});

describe("algToCurve — ES256_WEBAUTHN is never a plain-verify dispatch", () => {
  // -65800 shares the P-256 curve but its verify bytes are the assertion,
  // not the Sig_structure: enveloped verification lives inside
  // verifyCoseSign1WithParsedKey, and plain-verify dispatchers stay
  // fail-closed on the alg.
  it("returns null for -65800 despite the shared curve", () => {
    expect(algToCurve(COSE_ALG_ES256_WEBAUTHN)).toBeNull();
  });

  it("keeps the plain-verify set unchanged: ES256 maps, KS256 and unknowns do not", () => {
    expect(algToCurve(COSE_ALG_ES256)).toBe("P-256");
    expect(algToCurve(COSE_ALG_KS256)).toBeNull();
    expect(algToCurve(0)).toBeNull();
  });
});
