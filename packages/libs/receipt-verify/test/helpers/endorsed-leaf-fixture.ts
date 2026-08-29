/**
 * Endorsed-leaf fixture (ADR-0065): a passkey-rooted user log whose per-turn
 * leaf is signed by an endorsed SESSION key and carries the v2 endorsement
 * at unprotected label -65801, plus a receipt over that exact leaf.
 *
 * Synthetic WebAuthn material (the same construction as the encoding
 * package's -65800 envelope tests): the "passkey" is a P-256 key whose
 * assertion signs `authenticatorData ‖ sha256(clientDataJSON)` with the
 * challenge bound to the endorsement's Sig_structure.
 */

import {
  base64UrlEncode,
  COSE_ALG_ES256,
  COSE_LABEL_SESSION_KEY_ENDORSEMENT,
  encodeCborDeterministic,
  encodeCoseSign1Raw,
  encodeSigStructure,
} from "@forestrie/encoding";
import type { Proof } from "@forestrie/merklelog";
import {
  assembleSessionKeyEndorsement,
  buildSessionKeyEndorsementTbs,
  type SessionKeyEndorsementTbs,
} from "../../src/session-key-endorsement.js";
import { univocityLeafHash } from "../../src/leaf-commitment.js";
import {
  buildDetachedPeakReceipt,
  generateP256KeyPair,
  peakForLeafProof,
} from "./grant-receipt-fixture.js";
import { inclusionProofForIndex } from "./mmr-inclusion-proof.js";

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

export async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(
    await crypto.subtle.digest("SHA-256", new Uint8Array(bytes)),
  );
}

export async function exportXy(publicKey: CryptoKey): Promise<Uint8Array> {
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", publicKey));
  return raw.slice(1, 65);
}

/** Synthetic passkey gesture over the endorsement TBS. */
export async function synthesizeAssertion(
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

/** Root endorses `sessionPublicKeyXY` for `window` (v2), or a caller TBS. */
export async function buildEndorsement(
  root: CryptoKeyPair,
  sessionPublicKeyXY: Uint8Array,
  window: { notBefore: number; notAfter: number },
  opts?: { flags?: number; tbsOverride?: SessionKeyEndorsementTbs },
): Promise<Uint8Array> {
  const rootXy = await exportXy(root.publicKey);
  const tbs =
    opts?.tbsOverride ??
    buildSessionKeyEndorsementTbs({
      rootPublicKeyX: rootXy.slice(0, 32),
      sessionPublicKeyXY,
      ...window,
    });
  const assertion = await synthesizeAssertion(root, tbs.sigStructureBytes, {
    flags: opts?.flags,
  });
  return assembleSessionKeyEndorsement({ tbs, ...assertion });
}

/** Hand-rolled endorsement for negative shapes the strict TBS refuses. */
export async function assembleSessionKeyEndorsementForTest(
  root: CryptoKeyPair,
  parts: { protectedMap: Map<number, unknown>; payloadBstr: Uint8Array },
): Promise<Uint8Array> {
  const protectedBstr = encodeCborDeterministic(parts.protectedMap);
  const sigStructureBytes = encodeSigStructure(
    protectedBstr,
    new Uint8Array(0),
    parts.payloadBstr,
  );
  const assertion = await synthesizeAssertion(root, sigStructureBytes);
  return assembleSessionKeyEndorsement({
    tbs: { protectedBstr, payloadBstr: parts.payloadBstr, sigStructureBytes },
    ...assertion,
  });
}

/**
 * Plain-ES256 per-turn leaf signed by `signer` with protected
 * `{1: -7, 4: kid}` and the given unprotected entries (the ADR-0065 §2 shape
 * when `unprotected` holds the endorsement at -65801).
 */
export async function buildLeaf(
  signer: CryptoKeyPair,
  kid: Uint8Array,
  unprotected: Map<number, unknown>,
  payload: Uint8Array = new TextEncoder().encode("per-turn user envelope"),
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

/** Endorsed leaf: kid = session x, -65801 = endorsement bytes. */
export async function buildEndorsedLeaf(
  session: CryptoKeyPair,
  endorsement: Uint8Array,
  extraUnprotected?: Map<number, unknown>,
): Promise<Uint8Array> {
  const sessionXy = await exportXy(session.publicKey);
  const unprotected = new Map<number, unknown>([
    [COSE_LABEL_SESSION_KEY_ENDORSEMENT, endorsement],
    ...(extraUnprotected ?? []),
  ]);
  return buildLeaf(session, sessionXy.slice(0, 32), unprotected);
}

/**
 * Snowflake idtimestamp whose time component is `unixMs` (independent of the
 * implementation under test: `ms = 1*(2^40-1) + (id >> 24)`).
 */
export function idtimestampBe8ForUnixMs(unixMs: number): Uint8Array {
  const id = (BigInt(unixMs) - ((1n << 40n) - 1n)) << 24n;
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, id, false);
  return out;
}

/**
 * Receipt over `statement` sequenced at `idtimestampBe8` as leaf 1 of a
 * two-leaf MMR, sealed by `sealer` (the log root itself here — the sealer
 * delegation rung is covered by the delegated-receipt fixture and is
 * alg-agnostic, so the endorsed-leaf rung composes with it unchanged).
 */
export async function buildReceiptOverStatement(opts: {
  sealer: CryptoKeyPair;
  statement: Uint8Array;
  idtimestampBe8: Uint8Array;
}): Promise<Uint8Array> {
  const inner1 = await sha256(opts.statement);
  const inner0 = new Uint8Array(32).fill(0x0a);
  const leaf0Hash = await univocityLeafHash(new Uint8Array(8).fill(1), inner0);
  const leaf1Hash = await univocityLeafHash(opts.idtimestampBe8, inner1);
  const getHash = (i: bigint) => (i === 0n ? leaf0Hash : leaf1Hash);
  const proof: Proof = {
    path: inclusionProofForIndex(getHash, 1n, 1n),
    mmrIndex: 1n,
  };
  const peak = await peakForLeafProof(leaf1Hash, proof);
  return buildDetachedPeakReceipt({ signer: opts.sealer, peak, proof });
}

/** A fixed 7-day window (unix ms) and a leaf time inside it. */
export const WINDOW = {
  notBefore: 1_790_000_000_000,
  notAfter: 1_790_604_800_000,
};
export const LEAF_MS = 1_790_300_000_000;

export interface EndorsedLeafFixture {
  root: CryptoKeyPair;
  rootXy: Uint8Array;
  session: CryptoKeyPair;
  sessionXy: Uint8Array;
  endorsement: Uint8Array;
  statement: Uint8Array;
  idtimestampBe8: Uint8Array;
  receipt: Uint8Array;
}

export async function buildEndorsedLeafFixture(opts?: {
  flags?: number;
  leafMs?: number;
  window?: { notBefore: number; notAfter: number };
}): Promise<EndorsedLeafFixture> {
  const root = await generateP256KeyPair();
  const session = await generateP256KeyPair();
  const rootXy = await exportXy(root.publicKey);
  const sessionXy = await exportXy(session.publicKey);
  const endorsement = await buildEndorsement(
    root,
    sessionXy,
    opts?.window ?? WINDOW,
    { flags: opts?.flags },
  );
  const statement = await buildEndorsedLeaf(session, endorsement);
  const idtimestampBe8 = idtimestampBe8ForUnixMs(opts?.leafMs ?? LEAF_MS);
  const receipt = await buildReceiptOverStatement({
    sealer: root,
    statement,
    idtimestampBe8,
  });
  return {
    root,
    rootXy,
    session,
    sessionXy,
    endorsement,
    statement,
    idtimestampBe8,
    receipt,
  };
}
