/**
 * Passkey session-key endorsement (devdocs ADR-0064, plan-2608-13 Q5).
 *
 * A passkey log root signs ceremonies only; the per-turn user-envelope
 * signer is a separate session key, endorsed ONCE by the root via a COSE
 * Sign1 in the ADR-0063 WebAuthn envelope. This module owns both sides of
 * that artifact's byte-exact shape:
 *
 * - build/assemble: the client constructs the TBS, hashes its Sig_structure
 *   into the WebAuthn challenge, and attaches the assertion + signature;
 * - verify: given the passkey root as trust anchor, validate the artifact
 *   (typed, challenge-bound, fail-closed) and yield the session public key.
 *
 * The offline trust chain is then:
 *   grant (root = passkey x‖y) → endorsement → session key → plain-ES256
 *   per-turn leaves — zero per-leaf format change (ADR-0064 §4).
 *
 * Domain separation (ADR-0064 §2): the protected header carries the content
 * type below, and the payload is EXACTLY `{"sessionKey": bstr .size 64}`.
 * Anything else is a verification failure, never a fallback.
 */

import {
  COSE_ALG_ES256_WEBAUTHN,
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
 * Protected-header content type (label 3) naming the endorsement artifact.
 * Signed via Sig_structure, so the artifact's type is non-malleable.
 */
export const SESSION_KEY_ENDORSEMENT_CONTENT_TYPE =
  "application/vnd.forestrie.session-key-endorsement+cbor";

/** Payload map key holding the endorsed session public key (x‖y, 64 bytes). */
export const SESSION_KEY_PAYLOAD_KEY = "sessionKey";

/** To-be-signed endorsement halves plus the challenge preimage. */
export interface SessionKeyEndorsementTbs {
  /** Protected header map bytes `{1: -65800, 3: cty, 4: root x}`. */
  protectedBstr: Uint8Array;
  /** Payload bytes: deterministic CBOR `{"sessionKey": x‖y}`. */
  payloadBstr: Uint8Array;
  /**
   * `Sig_structure` over the halves. The WebAuthn challenge MUST be
   * `base64url(sha256(sigStructureBytes))` (ADR-0063 §3).
   */
  sigStructureBytes: Uint8Array;
}

/**
 * Build the endorsement TBS. The caller hashes `sigStructureBytes` into the
 * `navigator.credentials.get` challenge, then assembles with the assertion.
 *
 * @param input.rootPublicKeyX - Passkey root x coordinate (kid, 32 bytes)
 * @param input.sessionPublicKeyXY - Endorsed session public key x‖y (64 bytes)
 */
export function buildSessionKeyEndorsementTbs(input: {
  rootPublicKeyX: Uint8Array;
  sessionPublicKeyXY: Uint8Array;
}): SessionKeyEndorsementTbs {
  if (input.rootPublicKeyX.length !== 32) {
    throw new Error("endorsement kid must be the 32-byte root x coordinate");
  }
  if (input.sessionPublicKeyXY.length !== 64) {
    throw new Error("endorsed session key must be 64 bytes (x||y)");
  }
  const protectedBstr = encodeCborDeterministic(
    new Map<number, unknown>([
      [1, COSE_ALG_ES256_WEBAUTHN],
      [3, SESSION_KEY_ENDORSEMENT_CONTENT_TYPE],
      [4, input.rootPublicKeyX],
    ]),
  );
  const payloadBstr = encodeCborDeterministic(
    new Map<string, unknown>([
      [SESSION_KEY_PAYLOAD_KEY, input.sessionPublicKeyXY],
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

/** Verification outcome; failures name the first check that broke. */
export type SessionKeyEndorsementVerifyResult =
  | {
      ok: true;
      /** Endorsed session public key, raw x‖y (64 bytes). */
      sessionPublicKeyXY: Uint8Array;
      /** The same key imported for ES256 verify of per-turn leaves. */
      sessionKey: CryptoKey;
    }
  | {
      ok: false;
      reason:
        | "endorsement_malformed"
        | "wrong_alg"
        | "wrong_content_type"
        | "kid_invalid"
        | "kid_mismatch"
        | "payload_invalid"
        | "signature_invalid"
        | "session_key_import_failed";
    };

/** Options for {@link verifySessionKeyEndorsement}. */
export interface VerifySessionKeyEndorsementOptions {
  /**
   * Require the assertion's UV flag. Onboarding UV is DEPLOYMENT config,
   * not grant policy — the endorsement precedes the grant (ADR-0064 §3).
   * User presence is always required regardless.
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

function decodePayloadSessionKeyXy(payloadBstr: Uint8Array): Uint8Array | null {
  let decoded: unknown;
  try {
    decoded = decodeCborDeterministic(payloadBstr);
  } catch {
    return null;
  }
  // Exactly one entry, exactly the sessionKey label, exactly 64 bytes
  // (ADR-0064 §2) — anything else is a failure, never a partial read.
  let entries: [unknown, unknown][];
  if (decoded instanceof Map) {
    entries = [...decoded.entries()];
  } else if (typeof decoded === "object" && decoded !== null) {
    entries = Object.entries(decoded);
  } else {
    return null;
  }
  if (entries.length !== 1) return null;
  const [key, value] = entries[0]!;
  if (key !== SESSION_KEY_PAYLOAD_KEY) return null;
  if (!(value instanceof Uint8Array) || value.length !== 64) return null;
  return value;
}

/**
 * Verify a session-key endorsement under the passkey root and yield the
 * endorsed session key. All the ADR-0063 envelope checks (challenge binding
 * to this artifact's `Sig_structure`, UP flag, ceremony type, low-s, both
 * fail-closed directions) run inside the shared `-65800` verify branch;
 * this function adds the ADR-0064 typing rules on top.
 *
 * @param endorsementCbor - The endorsement COSE Sign1 bytes
 * @param rootKeys - Passkey root trust anchor(s), tried in order. Raw
 *   coordinate anchors additionally pin `kid == root x`.
 * @param opts - UV requirement (deployment config) and failure logging
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

  const sessionPublicKeyXY = decodePayloadSessionKeyXy(decoded.payloadBstr);
  if (!sessionPublicKeyXY) return { ok: false, reason: "payload_invalid" };

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
      sessionKey =
        await importEs256PublicKeyFromGrantDataXy64(sessionPublicKeyXY);
    } catch {
      return { ok: false, reason: "session_key_import_failed" };
    }
    return { ok: true, sessionPublicKeyXY, sessionKey };
  }

  return {
    ok: false,
    reason: kidMismatch ? "kid_mismatch" : "signature_invalid",
  };
}
