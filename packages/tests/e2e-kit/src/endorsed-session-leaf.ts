/**
 * Passkey custody for system tests (devdocs ADR-0064 §1 custody split as
 * amended by ADR-0065; plan-2608-14 4.1): a synthetic passkey ROOT (the log's
 * `grantData` / on-chain `logRootKey`) that signs ceremonies only, an
 * endorsed SESSION key that signs every per-turn leaf, and the v2 session-key
 * endorsement between them — riding INSIDE each leaf at unprotected label
 * `COSE_LABEL_SESSION_KEY_ENDORSEMENT` (-65801).
 *
 * The assertion construction is the kit's `syntheticWebauthnAssertion` (the
 * one the WebAuthn sealing delegation uses, plan-2608-13 2.4): the challenge
 * is `sha256(Sig_structure)` of the endorsement TBS, UP|UV by default, low-s
 * — exactly what a real authenticator produces, so a leaf built here is
 * admitted by canopy (`resolveEndorsedStatementSigner`) and verified offline
 * by `verifyEndorsedLeaf` with no test-only branch anywhere.
 *
 * Byte shape is owned by `@forestrie/receipt-verify`
 * (`buildSessionKeyEndorsementTbs` / `assembleSessionKeyEndorsement`); this
 * module composes, it does not re-encode.
 */

import {
  COSE_ALG_ES256,
  COSE_LABEL_SESSION_KEY_ENDORSEMENT,
  encodeCborDeterministic,
  encodeCoseSign1Raw,
  encodeSigStructure,
} from "@forestrie/encoding";
import {
  assembleSessionKeyEndorsement,
  buildSessionKeyEndorsementTbs,
  DEFAULT_ENDORSEMENT_WINDOW_MS,
  type EndorsementWindow,
} from "@forestrie/receipt-verify";
import {
  exportEs256RootXy,
  generateEs256RootKeyPair,
  syntheticWebauthnAssertion,
} from "./coordinator-delegation-helpers.js";

/**
 * Back-date `notBefore` by this much, as the thinker client does for a slow
 * browser clock (plan-2608-14 3.2); canopy additionally tolerates a 5-minute
 * forward skew, the offline rung none.
 */
export const ENDORSEMENT_NOT_BEFORE_BACKDATE_MS = 60_000;

/** A passkey root, an endorsed session key and the v2 endorsement between them. */
export interface PasskeySessionCustody {
  /** The synthetic passkey: signs ceremonies (endorsement, sealing delegation) only. */
  rootKeyPair: CryptoKeyPair;
  /** Raw x‖y (64 bytes) — the log's `grantData` and coordinator public root. */
  rootPublicKeyXY: Uint8Array;
  /** The endorsed per-turn signer. */
  sessionKeyPair: CryptoKeyPair;
  /** Raw x‖y (64 bytes); `[0:32]` is every endorsed leaf's kid. */
  sessionPublicKeyXY: Uint8Array;
  /** The v2 endorsement COSE Sign1 bytes carried by every leaf at -65801. */
  endorsement: Uint8Array;
  /** The endorsement's validity window, unix ms inclusive. */
  window: EndorsementWindow;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
}

async function exportXy(keyPair: CryptoKeyPair): Promise<Uint8Array> {
  const { x, y } = await exportEs256RootXy(keyPair);
  const xy = new Uint8Array(64);
  xy.set(x, 0);
  xy.set(y, 32);
  return xy;
}

/**
 * The passkey `root` endorses `sessionPublicKeyXY` for `window` (ADR-0065 §3
 * v2). One synthetic gesture; `uv: false` produces an endorsement a UV grant
 * must refuse (`endorsement_uv_required`).
 */
export async function buildSyntheticSessionKeyEndorsement(opts: {
  rootKeyPair: CryptoKeyPair;
  sessionPublicKeyXY: Uint8Array;
  window: EndorsementWindow;
  uv?: boolean;
  origin?: string;
}): Promise<Uint8Array> {
  const { x: rootX } = await exportEs256RootXy(opts.rootKeyPair);
  const tbs = buildSessionKeyEndorsementTbs({
    rootPublicKeyX: rootX,
    sessionPublicKeyXY: opts.sessionPublicKeyXY,
    ...opts.window,
  });
  const challenge = new Uint8Array(
    await crypto.subtle.digest("SHA-256", toArrayBuffer(tbs.sigStructureBytes)),
  );
  const assertion = await syntheticWebauthnAssertion({
    keyPair: opts.rootKeyPair,
    challenge,
    uv: opts.uv,
    origin: opts.origin,
  });
  return assembleSessionKeyEndorsement({ tbs, ...assertion });
}

/**
 * Mint a passkey root (or take one), a fresh session key, and the endorsement
 * between them over a window around now (default 7 days, `notBefore`
 * back-dated 60 s).
 */
export async function passkeySessionCustody(opts?: {
  rootKeyPair?: CryptoKeyPair;
  window?: EndorsementWindow;
  windowMs?: number;
  uv?: boolean;
  nowMs?: number;
}): Promise<PasskeySessionCustody> {
  const rootKeyPair = opts?.rootKeyPair ?? (await generateEs256RootKeyPair());
  const sessionKeyPair = await generateEs256RootKeyPair();
  const rootPublicKeyXY = await exportXy(rootKeyPair);
  const sessionPublicKeyXY = await exportXy(sessionKeyPair);
  const now = opts?.nowMs ?? Date.now();
  const window = opts?.window ?? {
    notBefore: now - ENDORSEMENT_NOT_BEFORE_BACKDATE_MS,
    notAfter: now + (opts?.windowMs ?? DEFAULT_ENDORSEMENT_WINDOW_MS),
  };
  const endorsement = await buildSyntheticSessionKeyEndorsement({
    rootKeyPair,
    sessionPublicKeyXY,
    window,
    uv: opts?.uv,
  });
  return {
    rootKeyPair,
    rootPublicKeyXY,
    sessionKeyPair,
    sessionPublicKeyXY,
    endorsement,
    window,
  };
}

/**
 * Plain-ES256 COSE Sign1 leaf signed by the SESSION key: protected
 * `{1: -7, 4: session x}`, unprotected `{-65801: endorsement}` (ADR-0065 §2).
 * Pass `endorsement: null` for a bare session-signed leaf — the exact bytes
 * canopy refused in the plan-2608-13 5.2 live run (`403 signer_mismatch`).
 */
export async function signEndorsedSessionStatement(opts: {
  custody: PasskeySessionCustody;
  payload: Uint8Array;
  /** Override the endorsement carried (a wrong-root one, say); `null` omits it. */
  endorsement?: Uint8Array | null;
}): Promise<Uint8Array> {
  const protectedBstr = encodeCborDeterministic(
    new Map<number, unknown>([
      [1, COSE_ALG_ES256],
      [4, opts.custody.sessionPublicKeyXY.subarray(0, 32)],
    ]),
  );
  const sigStructure = encodeSigStructure(
    protectedBstr,
    new Uint8Array(0),
    opts.payload,
  );
  const signature = new Uint8Array(
    await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      opts.custody.sessionKeyPair.privateKey,
      toArrayBuffer(sigStructure),
    ),
  );
  const endorsement =
    opts.endorsement === undefined
      ? opts.custody.endorsement
      : opts.endorsement;
  const unprotected = new Map<number, unknown>();
  if (endorsement) {
    unprotected.set(COSE_LABEL_SESSION_KEY_ENDORSEMENT, endorsement);
  }
  return encodeCoseSign1Raw(
    protectedBstr,
    unprotected,
    opts.payload,
    signature,
  );
}
