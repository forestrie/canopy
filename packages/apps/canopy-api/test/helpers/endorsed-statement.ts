/**
 * Endorsed-statement fixtures for register-signed-statement specs
 * (ADR-0065): a passkey-rooted data log whose per-turn leaf is signed by an
 * endorsed SESSION key and carries the v2 endorsement at unprotected label
 * -65801. The passkey is synthetic — a P-256 key whose assertion signs
 * `authenticatorData ‖ sha256(clientDataJSON)` with the challenge bound to
 * the endorsement's Sig_structure (the encoding package's -65800 test
 * construction; canopy does not pin rpIdHash).
 */

import {
  base64UrlEncode,
  COSE_ALG_ES256,
  COSE_LABEL_SESSION_KEY_ENDORSEMENT,
  encodeCborDeterministic,
  encodeCoseSign1Raw,
  encodeSigStructure,
} from "@forestrie/encoding";
import {
  assembleSessionKeyEndorsement,
  buildSessionKeyEndorsementTbs,
  type SessionKeyEndorsementTbs,
} from "@forestrie/receipt-verify";

export const FLAG_UP = 0x01;
export const FLAG_UV = 0x04;

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

export async function generateP256(): Promise<CryptoKeyPair> {
  return (await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
}

export async function exportXy(publicKey: CryptoKey): Promise<Uint8Array> {
  const raw = new Uint8Array(
    (await crypto.subtle.exportKey("raw", publicKey)) as ArrayBuffer,
  );
  return raw.slice(1, 65);
}

async function synthesizeAssertion(
  root: CryptoKeyPair,
  sigStructureBytes: Uint8Array,
  flags: number,
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
  authenticatorData[32] = flags;
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

/** A window around "now" (unix ms) unless overridden. */
export function windowAround(
  nowMs: number,
  opts?: { notBefore?: number; notAfter?: number },
): { notBefore: number; notAfter: number } {
  return {
    notBefore: opts?.notBefore ?? nowMs - 60_000,
    notAfter: opts?.notAfter ?? nowMs + 7 * 24 * 60 * 60 * 1000,
  };
}

/** Root endorses `sessionXy` for `window` (v2). */
export async function buildEndorsement(
  root: CryptoKeyPair,
  sessionXy: Uint8Array,
  window: { notBefore: number; notAfter: number },
  opts?: { flags?: number; tbsOverride?: SessionKeyEndorsementTbs },
): Promise<Uint8Array> {
  const rootXy = await exportXy(root.publicKey);
  const tbs =
    opts?.tbsOverride ??
    buildSessionKeyEndorsementTbs({
      rootPublicKeyX: rootXy.slice(0, 32),
      sessionPublicKeyXY: sessionXy,
      ...window,
    });
  const assertion = await synthesizeAssertion(
    root,
    tbs.sigStructureBytes,
    opts?.flags ?? FLAG_UP,
  );
  return assembleSessionKeyEndorsement({ tbs, ...assertion });
}

/** Hand-rolled endorsement for shapes the strict TBS builder refuses. */
export async function buildVariantEndorsement(
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
  const assertion = await synthesizeAssertion(root, sigStructureBytes, FLAG_UP);
  return assembleSessionKeyEndorsement({
    tbs: { protectedBstr, payloadBstr, sigStructureBytes },
    ...assertion,
  });
}

/**
 * Plain-ES256 statement signed by `signer` with protected `{1:-7, 4:kid}`
 * and the given unprotected entries.
 */
export async function signStatement(
  signer: CryptoKeyPair,
  kid: Uint8Array,
  unprotected: Map<number, unknown>,
  payload: Uint8Array = new TextEncoder().encode('{"turn":"hello"}'),
): Promise<Uint8Array> {
  const protectedBstr = encodeCborDeterministic(
    new Map<number, unknown>([
      [1, COSE_ALG_ES256],
      [4, kid],
    ]),
  );
  const sigStructure = encodeSigStructure(
    protectedBstr,
    new Uint8Array(0),
    payload,
  );
  const signature = new Uint8Array(
    await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      signer.privateKey,
      new Uint8Array(sigStructure),
    ),
  );
  return encodeCoseSign1Raw(protectedBstr, unprotected, payload, signature);
}

/** ADR-0065 §2 endorsed leaf: kid = session x, -65801 = endorsement bytes. */
export async function signEndorsedStatement(
  session: CryptoKeyPair,
  endorsement: unknown,
  extraUnprotected?: Map<number, unknown>,
): Promise<Uint8Array> {
  const sessionXy = await exportXy(session.publicKey);
  return signStatement(
    session,
    sessionXy.slice(0, 32),
    new Map<number, unknown>([
      [COSE_LABEL_SESSION_KEY_ENDORSEMENT, endorsement],
      ...(extraUnprotected ?? []),
    ]),
  );
}
