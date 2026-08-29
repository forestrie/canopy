/**
 * Session-key endorsement v2 verify (ADR-0064 as amended by ADR-0065 §3): the
 * passkey root endorses the plain-ES256 session key for a validity window
 * `[notBefore, notAfter]` (unix ms, the idtimestamp time domain). Synthetic
 * assertions mirror the encoding package's ES256_WEBAUTHN envelope tests
 * (same challenge-binding construction).
 */

import { describe, expect, it } from "vitest";
import {
  base64UrlEncode,
  COSE_ALG_ES256,
  encodeCborDeterministic,
  encodeCoseSign1Raw,
  encodeSigStructure,
  WEBAUTHN_ENVELOPE_LABEL,
} from "@forestrie/encoding";
import {
  assembleSessionKeyEndorsement,
  buildSessionKeyEndorsementTbs,
  SESSION_KEY_ENDORSEMENT_CONTENT_TYPE,
  SESSION_KEY_ENDORSEMENT_V1_CONTENT_TYPE,
  verifySessionKeyEndorsement,
  type SessionKeyEndorsementTbs,
} from "../src/session-key-endorsement.js";

/** A fixed, plausible 7-day window (unix ms). */
const WINDOW = { notBefore: 1_790_000_000_000, notAfter: 1_790_604_800_000 };

/** Deterministic v2 payload bytes for hand-rolled negative shapes. */
function v2Payload(sessionXy: Uint8Array): Uint8Array {
  return encodeCborDeterministic(
    new Map<string, unknown>([
      ["sessionKey", sessionXy],
      ["notBefore", WINDOW.notBefore],
      ["notAfter", WINDOW.notAfter],
    ]),
  );
}

const FLAG_UP = 0x01;
const FLAG_UV = 0x04;

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

async function exportXy(publicKey: CryptoKey): Promise<Uint8Array> {
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", publicKey));
  return raw.slice(1, 65);
}

/** Synthetic passkey gesture: sign the TBS's challenge-bound assertion. */
async function synthesizeAssertion(
  root: CryptoKeyPair,
  sigStructureBytes: Uint8Array,
  opts?: { flags?: number },
): Promise<{
  authenticatorData: Uint8Array;
  clientDataJSON: Uint8Array;
  signature: Uint8Array;
}> {
  const challenge = base64UrlEncode(await sha256(sigStructureBytes));
  const clientDataJSON = new TextEncoder().encode(
    `{"type":"webauthn.get","challenge":"${challenge}","origin":"https://thinker.example","crossOrigin":false}`,
  );
  const authenticatorData = new Uint8Array(37);
  authenticatorData.fill(0xa1, 0, 32);
  authenticatorData[32] = opts?.flags ?? FLAG_UP;
  const cdjHash = await sha256(clientDataJSON);
  const signedBytes = new Uint8Array(authenticatorData.length + 32);
  signedBytes.set(authenticatorData, 0);
  signedBytes.set(cdjHash, authenticatorData.length);
  const signature = toLowS(
    new Uint8Array(
      await crypto.subtle.sign(
        { name: "ECDSA", hash: "SHA-256" },
        root.privateKey,
        new Uint8Array(signedBytes),
      ),
    ),
  );
  return { authenticatorData, clientDataJSON, signature };
}

async function buildEndorsement(
  root: CryptoKeyPair,
  sessionPublicKeyXY: Uint8Array,
  opts?: { flags?: number; tbsOverride?: SessionKeyEndorsementTbs },
): Promise<Uint8Array> {
  const rootXy = await exportXy(root.publicKey);
  const tbs =
    opts?.tbsOverride ??
    buildSessionKeyEndorsementTbs({
      rootPublicKeyX: rootXy.slice(0, 32),
      sessionPublicKeyXY,
      ...WINDOW,
    });
  const assertion = await synthesizeAssertion(root, tbs.sigStructureBytes, {
    flags: opts?.flags,
  });
  return assembleSessionKeyEndorsement({ tbs, ...assertion });
}

/** Hand-rolled variant builder for negative shapes the strict TBS refuses. */
async function buildVariantEndorsement(
  root: CryptoKeyPair,
  protectedMap: Map<number, unknown>,
  payloadBstr: Uint8Array,
): Promise<Uint8Array> {
  const protectedBstr = encodeCborDeterministic(protectedMap);
  const sigStructureBytes = encodeSigStructure(
    protectedBstr,
    new Uint8Array(0),
    payloadBstr,
  );
  const assertion = await synthesizeAssertion(root, sigStructureBytes);
  return assembleSessionKeyEndorsement({
    tbs: { protectedBstr, payloadBstr, sigStructureBytes },
    ...assertion,
  });
}

describe("verifySessionKeyEndorsement v2 (ADR-0064 + ADR-0065 §3)", () => {
  it("round-trips: root endorses session key; returned key verifies a leaf signature", async () => {
    const root = await generateKeyPair();
    const session = await generateKeyPair();
    const sessionXy = await exportXy(session.publicKey);
    const endorsement = await buildEndorsement(root, sessionXy);

    const result = await verifySessionKeyEndorsement(
      endorsement,
      root.publicKey,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.sessionPublicKeyXY).toEqual(sessionXy);
    expect(result.notBefore).toBe(WINDOW.notBefore);
    expect(result.notAfter).toBe(WINDOW.notAfter);

    // The chain's last rung: a per-turn leaf signed by the session key
    // verifies under the key the endorsement yielded.
    const leaf = new TextEncoder().encode("per-turn user envelope bytes");
    const leafSig = await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      session.privateKey,
      leaf,
    );
    expect(
      await crypto.subtle.verify(
        { name: "ECDSA", hash: "SHA-256" },
        result.sessionKey,
        leafSig,
        leaf,
      ),
    ).toBe(true);
  });

  it("verifies under a raw-coordinate anchor and pins kid == root x", async () => {
    const root = await generateKeyPair();
    const session = await generateKeyPair();
    const sessionXy = await exportXy(session.publicKey);
    const rootXy = await exportXy(root.publicKey);
    const endorsement = await buildEndorsement(root, sessionXy);

    const good = await verifySessionKeyEndorsement(endorsement, {
      x: rootXy.slice(0, 32),
      y: rootXy.slice(32, 64),
      curve: "P-256",
    });
    expect(good.ok).toBe(true);

    // Same signing root, but the artifact's kid names a different key: a
    // coordinate anchor must refuse — artifact confusion, not authorization.
    const other = await generateKeyPair();
    const otherXy = await exportXy(other.publicKey);
    const tbs = buildSessionKeyEndorsementTbs({
      rootPublicKeyX: otherXy.slice(0, 32),
      sessionPublicKeyXY: sessionXy,
      ...WINDOW,
    });
    const mismatched = await buildEndorsement(root, sessionXy, {
      tbsOverride: tbs,
    });
    const bad = await verifySessionKeyEndorsement(mismatched, {
      x: rootXy.slice(0, 32),
      y: rootXy.slice(32, 64),
      curve: "P-256",
    });
    expect(bad).toEqual({ ok: false, reason: "kid_mismatch" });
  });

  it("rejects an endorsement signed by a different root", async () => {
    const root = await generateKeyPair();
    const impostor = await generateKeyPair();
    const session = await generateKeyPair();
    const endorsement = await buildEndorsement(
      impostor,
      await exportXy(session.publicKey),
    );
    const result = await verifySessionKeyEndorsement(
      endorsement,
      root.publicKey,
    );
    expect(result).toEqual({ ok: false, reason: "signature_invalid" });
  });

  it("rejects a plain-ES256-signed endorsement — wrong alg, even with a valid signature", async () => {
    const root = await generateKeyPair();
    const session = await generateKeyPair();
    const sessionXy = await exportXy(session.publicKey);
    const rootXy = await exportXy(root.publicKey);
    const protectedBstr = encodeCborDeterministic(
      new Map<number, unknown>([
        [1, COSE_ALG_ES256],
        [3, SESSION_KEY_ENDORSEMENT_CONTENT_TYPE],
        [4, rootXy.slice(0, 32)],
      ]),
    );
    const payloadBstr = v2Payload(sessionXy);
    const sigStructure = encodeSigStructure(
      protectedBstr,
      new Uint8Array(0),
      payloadBstr,
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
      payloadBstr,
      signature,
    );
    const result = await verifySessionKeyEndorsement(plain, root.publicKey);
    expect(result).toEqual({ ok: false, reason: "wrong_alg" });
  });

  it("rejects a missing or wrong content type — untyped -65800 artifacts never pass", async () => {
    const root = await generateKeyPair();
    const session = await generateKeyPair();
    const sessionXy = await exportXy(session.publicKey);
    const rootXy = await exportXy(root.publicKey);
    const payloadBstr = v2Payload(sessionXy);
    for (const cty of [
      undefined,
      "application/cbor",
      "application/vnd.forestrie.delegation+cbor",
      // v1 is rejected, not grandfathered (ADR-0065 §3) — even over a v2 payload.
      SESSION_KEY_ENDORSEMENT_V1_CONTENT_TYPE,
    ]) {
      const protectedMap = new Map<number, unknown>([
        [1, -65800],
        [4, rootXy.slice(0, 32)],
      ]);
      if (cty !== undefined) protectedMap.set(3, cty);
      const endorsement = await buildVariantEndorsement(
        root,
        protectedMap,
        payloadBstr,
      );
      const result = await verifySessionKeyEndorsement(
        endorsement,
        root.publicKey,
      );
      expect(result).toEqual({ ok: false, reason: "wrong_content_type" });
    }
  });

  it("rejects payloads that are not exactly {sessionKey: 64 bytes, notBefore, notAfter}", async () => {
    const root = await generateKeyPair();
    const session = await generateKeyPair();
    const sessionXy = await exportXy(session.publicKey);
    const rootXy = await exportXy(root.publicKey);
    const protectedMap = new Map<number, unknown>([
      [1, -65800],
      [3, SESSION_KEY_ENDORSEMENT_CONTENT_TYPE],
      [4, rootXy.slice(0, 32)],
    ]);
    const v2 = (over: Record<string, unknown>) =>
      encodeCborDeterministic(
        new Map<string, unknown>(
          Object.entries({
            sessionKey: sessionXy,
            notBefore: WINDOW.notBefore,
            notAfter: WINDOW.notAfter,
            ...over,
          }).filter(([, v]) => v !== undefined),
        ),
      );
    const badPayloads: Uint8Array[] = [
      encodeCborDeterministic(new Map()), // empty map
      v2({ sessionKey: sessionXy.slice(0, 32) }), // 32 bytes
      v2({ extra: 1 }), // extra entry
      v2({ sessionKey: undefined, key: sessionXy }), // wrong label
      encodeCborDeterministic(
        new Map<string, unknown>([["sessionKey", sessionXy]]),
      ), // v1 payload shape (no window) under the v2 content type
      v2({ notAfter: undefined }), // missing notAfter
      v2({ notBefore: undefined }), // missing notBefore
      v2({ notBefore: "soon" }), // wrong type
      v2({ notBefore: -1 }), // negative (must be an unsigned CBOR int)
      v2({ notAfter: new Uint8Array(8) }), // bstr where a uint is required
      encodeCborDeterministic(sessionXy), // bare bstr, not a map
    ];
    for (const payloadBstr of badPayloads) {
      const endorsement = await buildVariantEndorsement(
        root,
        protectedMap,
        payloadBstr,
      );
      const result = await verifySessionKeyEndorsement(
        endorsement,
        root.publicKey,
      );
      expect(result).toEqual({ ok: false, reason: "payload_invalid" });
    }
  });

  it("rejects a malformed window: notAfter <= notBefore", async () => {
    const root = await generateKeyPair();
    const session = await generateKeyPair();
    const sessionXy = await exportXy(session.publicKey);
    const rootXy = await exportXy(root.publicKey);
    const protectedMap = new Map<number, unknown>([
      [1, -65800],
      [3, SESSION_KEY_ENDORSEMENT_CONTENT_TYPE],
      [4, rootXy.slice(0, 32)],
    ]);
    for (const [notBefore, notAfter] of [
      [WINDOW.notAfter, WINDOW.notBefore], // inverted
      [WINDOW.notBefore, WINDOW.notBefore], // empty
    ]) {
      const payloadBstr = encodeCborDeterministic(
        new Map<string, unknown>([
          ["sessionKey", sessionXy],
          ["notBefore", notBefore],
          ["notAfter", notAfter],
        ]),
      );
      const endorsement = await buildVariantEndorsement(
        root,
        protectedMap,
        payloadBstr,
      );
      const result = await verifySessionKeyEndorsement(
        endorsement,
        root.publicKey,
      );
      expect(result).toEqual({ ok: false, reason: "window_invalid" });
    }
    // The builder refuses the same shapes up front.
    expect(() =>
      buildSessionKeyEndorsementTbs({
        rootPublicKeyX: rootXy.slice(0, 32),
        sessionPublicKeyXY: sessionXy,
        notBefore: WINDOW.notAfter,
        notAfter: WINDOW.notBefore,
      }),
    ).toThrow();
  });

  it("payload bytes are deterministic regardless of how the caller orders the window fields", () => {
    const rootX = new Uint8Array(32).fill(1);
    const sessionPublicKeyXY = new Uint8Array(64).fill(2);
    const a = buildSessionKeyEndorsementTbs({
      rootPublicKeyX: rootX,
      sessionPublicKeyXY,
      notBefore: WINDOW.notBefore,
      notAfter: WINDOW.notAfter,
    });
    // Same inputs, same bytes — the artifact the browser signs is the
    // artifact everyone verifies (RFC 8949 §4.2.1 key order).
    const b = buildSessionKeyEndorsementTbs({
      notAfter: WINDOW.notAfter,
      sessionPublicKeyXY,
      notBefore: WINDOW.notBefore,
      rootPublicKeyX: rootX,
    });
    expect(a.payloadBstr).toEqual(b.payloadBstr);
    expect(a.sigStructureBytes).toEqual(b.sigStructureBytes);
  });

  it("rejects a missing or malformed kid", async () => {
    const root = await generateKeyPair();
    const session = await generateKeyPair();
    const sessionXy = await exportXy(session.publicKey);
    const payloadBstr = v2Payload(sessionXy);
    for (const kid of [undefined, new Uint8Array(20), "not-bytes"]) {
      const protectedMap = new Map<number, unknown>([
        [1, -65800],
        [3, SESSION_KEY_ENDORSEMENT_CONTENT_TYPE],
      ]);
      if (kid !== undefined) protectedMap.set(4, kid);
      const endorsement = await buildVariantEndorsement(
        root,
        protectedMap,
        payloadBstr,
      );
      const result = await verifySessionKeyEndorsement(
        endorsement,
        root.publicKey,
      );
      expect(result).toEqual({ ok: false, reason: "kid_invalid" });
    }
  });

  it("enforces UV only when the caller requires it — distinct reason (ADR-0065 §4)", async () => {
    const root = await generateKeyPair();
    const session = await generateKeyPair();
    const sessionXy = await exportXy(session.publicKey);
    const upOnly = await buildEndorsement(root, sessionXy, { flags: FLAG_UP });
    const upUv = await buildEndorsement(root, sessionXy, {
      flags: FLAG_UP | FLAG_UV,
    });

    expect(
      await verifySessionKeyEndorsement(upOnly, root.publicKey, {
        requireUserVerification: true,
      }),
    ).toEqual({ ok: false, reason: "uv_required" });
    expect(
      (
        await verifySessionKeyEndorsement(upUv, root.publicKey, {
          requireUserVerification: true,
        })
      ).ok,
    ).toBe(true);
    expect((await verifySessionKeyEndorsement(upOnly, root.publicKey)).ok).toBe(
      true,
    );
  });

  it("rejects a tampered payload — the challenge binds this artifact's bytes", async () => {
    const root = await generateKeyPair();
    const session = await generateKeyPair();
    const attacker = await generateKeyPair();
    const sessionXy = await exportXy(session.publicKey);
    const attackerXy = await exportXy(attacker.publicKey);
    const rootXy = await exportXy(root.publicKey);

    // Assertion gesture bound to the honest TBS, payload swapped after.
    const honest = buildSessionKeyEndorsementTbs({
      rootPublicKeyX: rootXy.slice(0, 32),
      sessionPublicKeyXY: sessionXy,
      ...WINDOW,
    });
    const assertion = await synthesizeAssertion(root, honest.sigStructureBytes);
    const swapped = assembleSessionKeyEndorsement({
      tbs: { ...honest, payloadBstr: v2Payload(attackerXy) },
      ...assertion,
    });
    const result = await verifySessionKeyEndorsement(swapped, root.publicKey);
    expect(result).toEqual({ ok: false, reason: "signature_invalid" });
  });

  it("builder refuses malformed inputs", async () => {
    const session = await generateKeyPair();
    const sessionXy = await exportXy(session.publicKey);
    expect(() =>
      buildSessionKeyEndorsementTbs({
        rootPublicKeyX: new Uint8Array(20),
        sessionPublicKeyXY: sessionXy,
        ...WINDOW,
      }),
    ).toThrow();
    expect(() =>
      buildSessionKeyEndorsementTbs({
        rootPublicKeyX: new Uint8Array(32),
        sessionPublicKeyXY: sessionXy.slice(0, 32),
        ...WINDOW,
      }),
    ).toThrow();
    for (const bad of [-1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 2]) {
      expect(() =>
        buildSessionKeyEndorsementTbs({
          rootPublicKeyX: new Uint8Array(32),
          sessionPublicKeyXY: sessionXy,
          notBefore: bad,
          notAfter: WINDOW.notAfter,
        }),
      ).toThrow();
    }
  });
});
