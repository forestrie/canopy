/**
 * Passkey session-key endorsement, payload v2 (devdocs ADR-0064 as amended by
 * ADR-0065 §3; plan-2608-14 1.2).
 *
 * A passkey log root signs ceremonies only; the per-turn user-envelope
 * signer is a separate session key, endorsed by the root via a COSE Sign1 in
 * the ADR-0063 WebAuthn envelope. This module owns both sides of that
 * artifact's byte-exact shape:
 *
 * - build/assemble: the client constructs the TBS, hashes its Sig_structure
 *   into the WebAuthn challenge, and attaches the assertion + signature;
 * - verify: given the passkey root as trust anchor, validate the artifact
 *   (typed, challenge-bound, fail-closed) and yield the session public key
 *   and its validity window.
 *
 * The endorsement rides INSIDE every endorsed leaf (unprotected label
 * `COSE_LABEL_SESSION_KEY_ENDORSEMENT`, -65801) and the chain
 * root → endorsement → session key → leaf → receipt is walked by
 * {@link verifyEndorsedLeaf} (the single offline rung, ADR-0065 §5) and by
 * canopy SCRAPI admission (§4).
 *
 * Domain separation: the protected content type below names payload v2 and
 * the payload is EXACTLY `{"sessionKey": bstr .size 64, "notBefore": uint,
 * "notAfter": uint}` (unix milliseconds, the idtimestamp time domain).
 * Anything else — including a v1 (window-less) artifact — is a verification
 * failure, never a fallback (ADR-0065 §3: v1 is rejected, not grandfathered).
 *
 * The window itself is NOT checked here: the reference time differs per
 * verifier (canopy's clock at admission; the receipted idtimestamp offline).
 * Callers apply {@link checkEndorsementWindow} with the time they hold.
 */

import {
  COSE_ALG_ES256_WEBAUTHN,
  coseUnprotectedToMap,
  decodeCborDeterministic,
  decodeCoseSign1,
  encodeCborDeterministic,
  encodeCoseSign1Raw,
  encodeSigStructure,
  verifyCoseSign1WithParsedKey,
  WEBAUTHN_ENVELOPE_LABEL,
  type ParsedVerifyKey,
} from "@forestrie/encoding";
import { importEs256PublicKeyFromGrantDataXy64 } from "./decode-trust-root-cbor.js";

/**
 * Protected-header content type (label 3) naming the v2 endorsement artifact.
 * Signed via Sig_structure, so both the artifact's type AND its payload
 * version are non-malleable.
 */
export const SESSION_KEY_ENDORSEMENT_CONTENT_TYPE =
  "application/vnd.forestrie.session-key-endorsement.v2+cbor";

/**
 * The retired ADR-0064 v1 content type (payload without a window). Exported
 * only so verifiers and tests can name what is being REJECTED; no code path
 * accepts it.
 */
export const SESSION_KEY_ENDORSEMENT_V1_CONTENT_TYPE =
  "application/vnd.forestrie.session-key-endorsement+cbor";

/** Payload map key holding the endorsed session public key (x‖y, 64 bytes). */
export const SESSION_KEY_PAYLOAD_KEY = "sessionKey";
/** Payload map key: window start, unix milliseconds, inclusive. */
export const NOT_BEFORE_PAYLOAD_KEY = "notBefore";
/** Payload map key: window end, unix milliseconds, inclusive. */
export const NOT_AFTER_PAYLOAD_KEY = "notAfter";

/** Default client window length: 7 days (ADR-0065 §3). */
export const DEFAULT_ENDORSEMENT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/** WebAuthn authenticatorData UV flag bit (WebAuthn L2 §6.1). */
const AUTH_FLAG_UV = 0x04;

/** Validity window of an endorsement, unix milliseconds, both ends inclusive. */
export interface EndorsementWindow {
  notBefore: number;
  notAfter: number;
}

/** To-be-signed endorsement halves plus the challenge preimage. */
export interface SessionKeyEndorsementTbs {
  /** Protected header map bytes `{1: -65800, 3: cty(v2), 4: root x}`. */
  protectedBstr: Uint8Array;
  /** Payload bytes: deterministic CBOR `{sessionKey, notBefore, notAfter}`. */
  payloadBstr: Uint8Array;
  /**
   * `Sig_structure` over the halves. The WebAuthn challenge MUST be
   * `base64url(sha256(sigStructureBytes))` (ADR-0063 §3).
   */
  sigStructureBytes: Uint8Array;
}

function isUnixMs(v: unknown): v is number {
  return typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
}

/**
 * Structural window check shared by the builder and the verifier: both ends
 * are unsigned safe integers and the window is non-empty (ADR-0065 §3
 * "malformed windows are rejected": `notAfter ≤ notBefore`).
 */
function windowWellFormed(w: {
  notBefore: unknown;
  notAfter: unknown;
}): w is EndorsementWindow {
  return (
    isUnixMs(w.notBefore) && isUnixMs(w.notAfter) && w.notAfter > w.notBefore
  );
}

/**
 * Build the v2 endorsement TBS. The caller hashes `sigStructureBytes` into
 * the `navigator.credentials.get` challenge, then assembles with the assertion.
 *
 * @param input.rootPublicKeyX - Passkey root x coordinate (kid, 32 bytes)
 * @param input.sessionPublicKeyXY - Endorsed session public key x‖y (64 bytes)
 * @param input.notBefore - Window start, unix ms inclusive
 * @param input.notAfter - Window end, unix ms inclusive; must exceed notBefore
 */
export function buildSessionKeyEndorsementTbs(input: {
  rootPublicKeyX: Uint8Array;
  sessionPublicKeyXY: Uint8Array;
  notBefore: number;
  notAfter: number;
}): SessionKeyEndorsementTbs {
  if (input.rootPublicKeyX.length !== 32) {
    throw new Error("endorsement kid must be the 32-byte root x coordinate");
  }
  if (input.sessionPublicKeyXY.length !== 64) {
    throw new Error("endorsed session key must be 64 bytes (x||y)");
  }
  if (!windowWellFormed(input)) {
    throw new Error(
      "endorsement window must be unsigned safe-integer unix ms with notAfter > notBefore",
    );
  }
  const protectedBstr = encodeCborDeterministic(
    new Map<number, unknown>([
      [1, COSE_ALG_ES256_WEBAUTHN],
      [3, SESSION_KEY_ENDORSEMENT_CONTENT_TYPE],
      [4, input.rootPublicKeyX],
    ]),
  );
  // Deterministic CBOR sorts the keys (RFC 8949 §4.2.1); insertion order here
  // is irrelevant to the bytes.
  const payloadBstr = encodeCborDeterministic(
    new Map<string, unknown>([
      [SESSION_KEY_PAYLOAD_KEY, input.sessionPublicKeyXY],
      [NOT_BEFORE_PAYLOAD_KEY, input.notBefore],
      [NOT_AFTER_PAYLOAD_KEY, input.notAfter],
    ]),
  );
  const sigStructureBytes = encodeSigStructure(
    protectedBstr,
    new Uint8Array(0),
    payloadBstr,
  );
  return { protectedBstr, payloadBstr, sigStructureBytes };
}

/**
 * Assemble the final endorsement COSE Sign1: the assertion rides in the
 * unprotected header at label -65800 (ADR-0063 §2), the signature is the
 * assertion's, converted to low-s P1363 r‖s by the caller (see
 * delegation-cose `derSignatureToP1363` / low-s normalisation).
 */
export function assembleSessionKeyEndorsement(input: {
  tbs: SessionKeyEndorsementTbs;
  authenticatorData: Uint8Array;
  clientDataJSON: Uint8Array;
  /** Low-s P1363 r‖s (64 bytes). */
  signature: Uint8Array;
}): Uint8Array {
  if (input.signature.length !== 64) {
    throw new Error("endorsement signature must be 64-byte P1363 r||s");
  }
  const unprotected = new Map<number, unknown>([
    [WEBAUTHN_ENVELOPE_LABEL, [input.authenticatorData, input.clientDataJSON]],
  ]);
  return encodeCoseSign1Raw(
    input.tbs.protectedBstr,
    unprotected,
    input.tbs.payloadBstr,
    input.signature,
  );
}

/** Verification failure reasons; the first check that broke. */
export type SessionKeyEndorsementFailureReason =
  | "endorsement_malformed"
  | "wrong_alg"
  | "wrong_content_type"
  | "kid_invalid"
  | "kid_mismatch"
  | "payload_invalid"
  | "window_invalid"
  | "uv_required"
  | "signature_invalid"
  | "session_key_import_failed";

/** Verification outcome; failures name the first check that broke. */
export type SessionKeyEndorsementVerifyResult =
  | ({
      ok: true;
      /** Endorsed session public key, raw x‖y (64 bytes). */
      sessionPublicKeyXY: Uint8Array;
      /** The same key imported for ES256 verify of per-turn leaves. */
      sessionKey: CryptoKey;
    } & EndorsementWindow)
  | { ok: false; reason: SessionKeyEndorsementFailureReason };

/** Options for {@link verifySessionKeyEndorsement}. */
export interface VerifySessionKeyEndorsementOptions {
  /**
   * Require the assertion's UV flag. At admission this is the grant's
   * `GF_REQUIRES_USER_VERIFICATION` (ADR-0065 §4); at DO onboarding, where
   * no grant exists yet, deployment config (ADR-0064 §3). User presence is
   * always required regardless.
   */
  requireUserVerification?: boolean;
  /** Emit JSON warning lines on failure paths (no secrets). */
  logFailures?: boolean;
  /** Included in JSON log lines. */
  logPrefix?: string;
}

function protectedHeaderEntries(
  protectedBstr: Uint8Array,
): { alg: unknown; cty: unknown; kid: unknown } | null {
  let decoded: unknown;
  try {
    decoded = decodeCborDeterministic(protectedBstr);
  } catch {
    return null;
  }
  if (decoded instanceof Map) {
    return { alg: decoded.get(1), cty: decoded.get(3), kid: decoded.get(4) };
  }
  if (typeof decoded === "object" && decoded !== null) {
    const obj = decoded as Record<string | number, unknown>;
    return {
      alg: obj[1] ?? obj["1"],
      cty: obj[3] ?? obj["3"],
      kid: obj[4] ?? obj["4"],
    };
  }
  return null;
}

type DecodedPayload =
  | { kind: "ok"; sessionPublicKeyXY: Uint8Array; window: EndorsementWindow }
  | { kind: "payload_invalid" }
  | { kind: "window_invalid" };

function toNumberIfInt(v: unknown): unknown {
  // Deterministic decode may surface large ints as bigint; the window is
  // unix ms (< 2^53) so a safe bigint is folded back to a number.
  if (
    typeof v === "bigint" &&
    v >= 0n &&
    v <= BigInt(Number.MAX_SAFE_INTEGER)
  ) {
    return Number(v);
  }
  return v;
}

function decodePayloadV2(payloadBstr: Uint8Array): DecodedPayload {
  let decoded: unknown;
  try {
    decoded = decodeCborDeterministic(payloadBstr);
  } catch {
    return { kind: "payload_invalid" };
  }
  // Exactly three entries, exactly the three labels, exactly these shapes
  // (ADR-0065 §3) — anything else is a failure, never a partial read.
  let entries: [unknown, unknown][];
  if (decoded instanceof Map) {
    entries = [...decoded.entries()];
  } else if (typeof decoded === "object" && decoded !== null) {
    entries = Object.entries(decoded);
  } else {
    return { kind: "payload_invalid" };
  }
  if (entries.length !== 3) return { kind: "payload_invalid" };
  const byKey = new Map<unknown, unknown>(entries);
  const sessionPublicKeyXY = byKey.get(SESSION_KEY_PAYLOAD_KEY);
  if (
    !(sessionPublicKeyXY instanceof Uint8Array) ||
    sessionPublicKeyXY.length !== 64
  ) {
    return { kind: "payload_invalid" };
  }
  const notBefore = toNumberIfInt(byKey.get(NOT_BEFORE_PAYLOAD_KEY));
  const notAfter = toNumberIfInt(byKey.get(NOT_AFTER_PAYLOAD_KEY));
  if (!isUnixMs(notBefore) || !isUnixMs(notAfter)) {
    return { kind: "payload_invalid" };
  }
  const window = { notBefore, notAfter };
  if (!windowWellFormed(window)) return { kind: "window_invalid" };
  return { kind: "ok", sessionPublicKeyXY, window };
}

/** Read the assertion's flags byte from the -65800 envelope, if well-shaped. */
function envelopeFlags(unprotected: unknown): number | null {
  const envelope = coseUnprotectedToMap(unprotected).get(
    WEBAUTHN_ENVELOPE_LABEL,
  );
  if (!Array.isArray(envelope) || envelope.length !== 2) return null;
  const authenticatorData = envelope[0];
  if (
    !(authenticatorData instanceof Uint8Array) ||
    authenticatorData.length < 37
  ) {
    return null;
  }
  return authenticatorData[32]!;
}

/**
 * Verify a v2 session-key endorsement under the passkey root and yield the
 * endorsed session key plus its window. All the ADR-0063 envelope checks
 * (challenge binding to this artifact's `Sig_structure`, UP flag, ceremony
 * type, low-s, both fail-closed directions) run inside the shared `-65800`
 * verify branch; this function adds the ADR-0064/0065 typing rules on top
 * and reports a missing-UV rejection under its own reason so admission can
 * name it (`endorsement_uv_required`, ADR-0065 §4).
 *
 * @param endorsementCbor - The endorsement COSE Sign1 bytes
 * @param rootKeys - Passkey root trust anchor(s), tried in order. Raw
 *   coordinate anchors additionally pin `kid == root x`.
 * @param opts - UV requirement and failure logging
 */
export async function verifySessionKeyEndorsement(
  endorsementCbor: Uint8Array,
  rootKeys: ParsedVerifyKey | ParsedVerifyKey[],
  opts?: VerifySessionKeyEndorsementOptions,
): Promise<SessionKeyEndorsementVerifyResult> {
  const anchors = Array.isArray(rootKeys) ? rootKeys : [rootKeys];

  const decoded = decodeCoseSign1(endorsementCbor);
  if (!decoded) return { ok: false, reason: "endorsement_malformed" };

  const header = protectedHeaderEntries(decoded.protectedBstr);
  if (!header) return { ok: false, reason: "endorsement_malformed" };

  const alg = typeof header.alg === "bigint" ? Number(header.alg) : header.alg;
  if (alg !== COSE_ALG_ES256_WEBAUTHN) {
    return { ok: false, reason: "wrong_alg" };
  }
  if (header.cty !== SESSION_KEY_ENDORSEMENT_CONTENT_TYPE) {
    return { ok: false, reason: "wrong_content_type" };
  }
  if (!(header.kid instanceof Uint8Array) || header.kid.length !== 32) {
    return { ok: false, reason: "kid_invalid" };
  }

  const payload = decodePayloadV2(decoded.payloadBstr);
  if (payload.kind !== "ok") return { ok: false, reason: payload.kind };

  if (opts?.requireUserVerification) {
    const flags = envelopeFlags(decoded.unprotected);
    // A malformed envelope is left to the shared branch to reject; only a
    // well-shaped assertion that plainly lacks UV gets the distinct reason.
    if (flags !== null && (flags & AUTH_FLAG_UV) === 0) {
      return { ok: false, reason: "uv_required" };
    }
  }

  let kidMismatch = false;
  for (const anchor of anchors) {
    // When the anchor exposes raw coordinates, the signed kid must name it —
    // a valid signature under a root whose x is not the kid is evidence of
    // artifact confusion, not authorization (ADR-0064 §2 kid = root x).
    if (!(anchor instanceof CryptoKey)) {
      const x = anchor.x;
      if (
        x.length !== header.kid.length ||
        !x.every((b, i) => b === (header.kid as Uint8Array)[i])
      ) {
        kidMismatch = true;
        continue;
      }
    }
    const sigOk = await verifyCoseSign1WithParsedKey(endorsementCbor, anchor, {
      requireUserVerification: opts?.requireUserVerification,
      logFailures: opts?.logFailures,
      logPrefix: opts?.logPrefix ?? "session-key-endorsement",
    });
    if (!sigOk) continue;

    let sessionKey: CryptoKey;
    try {
      sessionKey = await importEs256PublicKeyFromGrantDataXy64(
        payload.sessionPublicKeyXY,
      );
    } catch {
      return { ok: false, reason: "session_key_import_failed" };
    }
    return {
      ok: true,
      sessionPublicKeyXY: payload.sessionPublicKeyXY,
      sessionKey,
      ...payload.window,
    };
  }

  return {
    ok: false,
    reason: kidMismatch ? "kid_mismatch" : "signature_invalid",
  };
}

/** Outcome of {@link checkEndorsementWindow}. */
export type EndorsementWindowCheck =
  | { ok: true }
  | { ok: false; reason: "endorsement_not_yet_valid" | "endorsement_expired" };

/**
 * Is `atMs` inside the endorsement's window? `notBefore ≤ atMs ≤ notAfter`,
 * both inclusive (ADR-0065 §3). `skewMs` (default 0) tolerates a `notBefore`
 * slightly in the future of a wall-clock verifier; offline verifiers
 * comparing against the receipted idtimestamp should leave it at 0 — that
 * comparison is exact and authoritative.
 *
 * Deliberately a pure function of the two numbers so callers can (and must)
 * run it on every request, structurally outside any verified-endorsement
 * cache (ADR-0065 §4).
 */
export function checkEndorsementWindow(
  window: EndorsementWindow,
  atMs: number,
  opts?: { skewMs?: number },
): EndorsementWindowCheck {
  const skew = opts?.skewMs ?? 0;
  if (atMs + skew < window.notBefore) {
    return { ok: false, reason: "endorsement_not_yet_valid" };
  }
  if (atMs > window.notAfter) {
    return { ok: false, reason: "endorsement_expired" };
  }
  return { ok: true };
}
