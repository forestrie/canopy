/**
 * Cryptographic verification of COSE Sign1 (statement).
 * Supports ES256 (P-256 via Web Crypto) and, for delegation certificates,
 * ES256_WEBAUTHN (-65800): the same P-256 key, but the signature is a WebAuthn
 * assertion whose envelope rides in the unprotected header (devdocs ADR-0063).
 * KS256 (-65799) verification lives in canopy-api/arbor paths (Keccak +
 * ecrecover / ERC-1271), not this module.
 */

import { base64UrlEncode } from "./base64url.js";
import { coseUnprotectedToMap } from "./cose-unprotected-map.js";
import {
  decodeCborDeterministic,
  decodeCborUnwrapCose,
} from "./decode-cbor-deterministic.js";
import { encodeSigStructure } from "./encode-sig-structure.js";

/** COSE algorithm identifiers (RFC 9053). */
export const COSE_ALG_ES256 = -7;
/** KS256: secp256k1 + Keccak-256 + Ethereum address (COSE private use). */
export const COSE_ALG_KS256 = -65799;
/**
 * ES256_WEBAUTHN: P-256 key whose signature is a WebAuthn assertion (univocity
 * ADR-0008; COSE private use). Off-chain the assertion envelope rides in the
 * unprotected header at the label {@link WEBAUTHN_ENVELOPE_LABEL} (ADR-0063).
 */
export const COSE_ALG_ES256_WEBAUTHN = -65800;
/**
 * Unprotected header label carrying the certificate's WebAuthn envelope, a
 * 2-element CBOR array `[authenticatorData, clientDataJSON]` (ADR-0063: the
 * alg id doubles as the label; no on-chain-style index-hint element).
 */
export const WEBAUTHN_ENVELOPE_LABEL = COSE_ALG_ES256_WEBAUTHN;
/**
 * Unprotected header label carrying a passkey session-key endorsement (a COSE
 * Sign1, embedded as bytes) on every endorsed per-turn leaf (devdocs ADR-0065
 * §2). Reserved for that artifact only — it is NOT the WebAuthn envelope: a
 * -65800 entry on a plain-ES256 leaf stays a fail-closed rejection here, and
 * this label is deliberately ignored by the plain verify path (the endorsed
 * leaf verifies under the SESSION key; only `@forestrie/receipt-verify`
 * `verifyEndorsedLeaf` / canopy admission chain root → endorsement → leaf).
 */
export const COSE_LABEL_SESSION_KEY_ENDORSEMENT = -65801;

/** WebAuthn authenticatorData flag bits (WebAuthn L2 §6.1). */
const AUTH_FLAG_UP = 0x01;
const AUTH_FLAG_UV = 0x04;
const AUTH_FLAG_BE = 0x08;
const AUTH_FLAG_BS = 0x10;
/** rpIdHash (32) ‖ flags (1) ‖ signCount (4). */
const AUTH_DATA_MIN_BYTES = 37;

/** P-256 group order for the low-s canonical-form check (matches OZ P256). */
const P256_N = BigInt(
  "0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551",
);
const P256_HALF_N = P256_N >> 1n;

function isLowS(signature: Uint8Array): boolean {
  let s = 0n;
  for (let i = 32; i < 64; i++) {
    s = (s << 8n) | BigInt(signature[i]!);
  }
  return s <= P256_HALF_N;
}

/** Supported COSE algorithms for ES256 delegate-key verification in this module. */
export type CoseAlgorithm = "ES256";

/** Parsed EC public key coordinates for verification without a CryptoKey. */
export interface ParsedEcPublicKey {
  /** X coordinate (32 bytes). */
  x: Uint8Array;
  /** Y coordinate (32 bytes). */
  y: Uint8Array;
  /** Curve name. */
  curve: "P-256";
}

/** Verify key accepted by {@link verifyCoseSign1WithParsedKey}. */
export type ParsedVerifyKey = CryptoKey | ParsedEcPublicKey;

/** Optional structured logging when verification fails (no secrets logged). */
export interface VerifyCoseSign1Options {
  /** When true, emit JSON warning lines on failure paths. */
  logFailures?: boolean;
  /** Included in JSON log lines under `prefix`. */
  logPrefix?: string;
  /**
   * Payload bytes for detached-content verification. When the COSE Sign1 has a
   * nil/detached payload but the signature was computed over the real content,
   * supply the original payload here. It replaces the empty bstr in the
   * Sig_structure so the signature can be verified.
   */
  detachedPayload?: Uint8Array;
  /**
   * ES256_WEBAUTHN only: require the assertion's UV flag (grant-declared
   * `GF_REQUIRES_USER_VERIFICATION`, ADR-0063 §4). A verifier without the
   * grant in evidence leaves this unset; the on-chain verifier backstops UV
   * at publish. User presence (UP) is always required.
   */
  requireUserVerification?: boolean;
}

function hexPreview(bytes: Uint8Array, maxBytes: number): string {
  const n = Math.min(maxBytes, bytes.length);
  let s = "";
  for (let i = 0; i < n; i++) {
    s += bytes[i]!.toString(16).padStart(2, "0");
  }
  if (bytes.length > n) s += "…";
  return s;
}

async function sha256HexPrefix16(bytes: Uint8Array): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new Uint8Array(bytes));
  return hexPreview(new Uint8Array(d), 8);
}

function logVerifyFailure(
  opts: VerifyCoseSign1Options | undefined,
  msg: string,
  extra: Record<string, unknown>,
): void {
  if (!opts?.logFailures) return;
  console.warn(
    JSON.stringify({
      tag: "verifyCoseSign1Failure",
      prefix: opts.logPrefix ?? "",
      reason: msg,
      ...extra,
    }),
  );
}

/**
 * Extract the `alg` value from COSE protected header bytes.
 *
 * @param protectedBstr - Decoded COSE Sign1 `[0]` protected header contents
 * @returns Numeric COSE algorithm id, or null when missing or unparseable
 */
export function extractAlgFromProtected(
  protectedBstr: Uint8Array,
): number | null {
  if (protectedBstr.length === 0) return null;
  try {
    const map = decodeCborDeterministic(protectedBstr) as unknown;
    if (map instanceof Map) {
      const alg = map.get(1);
      if (typeof alg === "number") return alg;
      if (typeof alg === "bigint") return Number(alg);
    } else if (typeof map === "object" && map !== null) {
      const obj = map as Record<string | number, unknown>;
      const alg = obj[1] ?? obj["1"];
      if (typeof alg === "number") return alg;
      if (typeof alg === "bigint") return Number(alg);
    }
  } catch {
    // Invalid CBOR
  }
  return null;
}

/**
 * Map COSE algorithm number to Web Crypto curve name (ES256 only here).
 * ES256_WEBAUTHN (-65800) deliberately stays null: it shares the curve but is
 * never a plain Sig_structure verify — enveloped verification happens inside
 * {@link verifyCoseSign1WithParsedKey}, and callers dispatching a plain verify
 * off this mapping must stay fail-closed on it.
 *
 * @param alg - COSE `alg` header value
 * @returns `"P-256"` for ES256, otherwise null
 */
export function algToCurve(alg: number): "P-256" | null {
  if (alg === COSE_ALG_ES256) return "P-256";
  return null;
}

/**
 * Verify COSE Sign1 signature with a Web Crypto public key (ES256, or
 * ES256_WEBAUTHN for enveloped delegation certificates).
 * Builds Sig_structure per RFC 8152; signature must be IEEE P1363 R‖S (64 bytes).
 *
 * @param coseSign1Bytes - CBOR COSE Sign1 tuple
 * @param publicKey - P-256 verify key
 * @param opts - Optional detached payload and failure logging
 * @returns True when signature verifies; false on any malformed input
 */
export async function verifyCoseSign1(
  coseSign1Bytes: Uint8Array,
  publicKey: CryptoKey,
  opts?: VerifyCoseSign1Options,
): Promise<boolean> {
  return verifyCoseSign1WithParsedKey(coseSign1Bytes, publicKey, opts);
}

/**
 * Validate the ES256_WEBAUTHN unprotected-header envelope and return the bytes
 * the authenticator actually signed: `authenticatorData ‖ sha256(clientDataJSON)`
 * (WebAuthn L2 §6.3.3; the P-256 verify hashes these with SHA-256). The
 * envelope itself is unsigned, so trust hinges entirely on the challenge
 * binding: `clientDataJSON.challenge == base64url(sha256(Sig_structure))`
 * re-derives the tie to the certificate body (ADR-0063 §3). rpIdHash is not
 * pinned (deferred, mirroring the contract's dormant parameter).
 *
 * @returns Signed-bytes on success, or null (with optional logging) on any
 *   malformed or unbound envelope — fail-closed, never a plain-ES256 fallback
 */
async function webauthnEnvelopeSignedBytes(
  envelope: unknown,
  sigStructure: Uint8Array,
  signature: Uint8Array,
  opts?: VerifyCoseSign1Options,
): Promise<Uint8Array | null> {
  if (!Array.isArray(envelope) || envelope.length !== 2) {
    logVerifyFailure(opts, "webauthn_envelope_malformed", {
      isArray: Array.isArray(envelope),
      length: Array.isArray(envelope) ? envelope.length : undefined,
    });
    return null;
  }
  const [authenticatorData, clientDataJSON] = envelope as unknown[];
  if (
    !(authenticatorData instanceof Uint8Array) ||
    !(clientDataJSON instanceof Uint8Array) ||
    authenticatorData.length < AUTH_DATA_MIN_BYTES
  ) {
    logVerifyFailure(opts, "webauthn_envelope_malformed", {
      authenticatorDataLen:
        authenticatorData instanceof Uint8Array
          ? authenticatorData.length
          : undefined,
    });
    return null;
  }

  const flags = authenticatorData[32]!;
  if ((flags & AUTH_FLAG_UP) === 0) {
    logVerifyFailure(opts, "webauthn_user_presence_missing", { flags });
    return null;
  }
  if (opts?.requireUserVerification && (flags & AUTH_FLAG_UV) === 0) {
    logVerifyFailure(opts, "webauthn_user_verification_missing", { flags });
    return null;
  }
  // Backed up (BS) without backup eligible (BE) is an impossible
  // authenticator state; treat as malformed (contract parity).
  if ((flags & AUTH_FLAG_BE) === 0 && (flags & AUTH_FLAG_BS) !== 0) {
    logVerifyFailure(opts, "webauthn_flags_invalid", { flags });
    return null;
  }

  // Off-chain we parse clientDataJSON properly — no carried index hints
  // (ADR-0063 §2 deliberately diverges from the on-chain algData here).
  let clientData: { type?: unknown; challenge?: unknown };
  try {
    clientData = JSON.parse(new TextDecoder().decode(clientDataJSON)) as {
      type?: unknown;
      challenge?: unknown;
    };
  } catch {
    logVerifyFailure(opts, "webauthn_client_data_unparseable", {
      clientDataLen: clientDataJSON.length,
    });
    return null;
  }
  if (clientData.type !== "webauthn.get") {
    logVerifyFailure(opts, "webauthn_wrong_ceremony_type", {
      type: typeof clientData.type === "string" ? clientData.type : undefined,
    });
    return null;
  }
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new Uint8Array(sigStructure),
  );
  const expectedChallenge = base64UrlEncode(new Uint8Array(digest));
  if (clientData.challenge !== expectedChallenge) {
    logVerifyFailure(opts, "webauthn_challenge_mismatch", {
      sigStructureSha256HexPrefix: await sha256HexPrefix16(sigStructure),
    });
    return null;
  }

  // The wire form is low-s normalized (ADR-0063 §2); WebCrypto would accept
  // the malleable high-s twin, so reject it for canonical-form parity.
  if (!isLowS(signature)) {
    logVerifyFailure(opts, "webauthn_signature_high_s", {
      signatureHeadHex: hexPreview(signature, 8),
    });
    return null;
  }

  const clientDataHash = await crypto.subtle.digest(
    "SHA-256",
    new Uint8Array(clientDataJSON),
  );
  const signed = new Uint8Array(authenticatorData.length + 32);
  signed.set(authenticatorData, 0);
  signed.set(new Uint8Array(clientDataHash), authenticatorData.length);
  return signed;
}

/**
 * Verify COSE Sign1 with a {@link ParsedVerifyKey} (CryptoKey or raw P-256 coords).
 *
 * Alg handling is fail-closed both directions (ADR-0063 §5): under
 * ES256_WEBAUTHN a missing/malformed envelope fails (never a plain-verify
 * fallback), and under any other alg a present envelope label is rejected —
 * alg-specific material under an alg that defines none is evidence of
 * confusion, never ignorable.
 *
 * @param coseSign1Bytes - CBOR COSE Sign1 tuple
 * @param verifyKey - Web Crypto key or parsed coordinates
 * @param opts - Optional detached payload and failure logging
 * @returns True when signature verifies; false on any malformed input
 */
export async function verifyCoseSign1WithParsedKey(
  coseSign1Bytes: Uint8Array,
  verifyKey: ParsedVerifyKey,
  opts?: VerifyCoseSign1Options,
): Promise<boolean> {
  const decoded = decodeCoseSign1(coseSign1Bytes);
  if (!decoded) {
    logVerifyFailure(opts, "decode_failed", {
      coseSign1Len: coseSign1Bytes.length,
      coseSign1HeadHex: hexPreview(coseSign1Bytes, 16),
    });
    return false;
  }

  const { protectedBstr, payloadBstr, signature } = decoded;

  if (signature.length !== 64) {
    logVerifyFailure(opts, "signature_wrong_length", {
      signatureLen: signature.length,
      signatureHeadHex: hexPreview(signature, 8),
      signatureLooksLikeASN1DER: signature.length > 0 && signature[0] === 0x30,
    });
    return false;
  }

  const alg = extractAlgFromProtected(protectedBstr);
  const envelope = coseUnprotectedToMap(decoded.unprotected).get(
    WEBAUTHN_ENVELOPE_LABEL,
  );
  if (alg !== COSE_ALG_ES256_WEBAUTHN && envelope !== undefined) {
    logVerifyFailure(opts, "unexpected_webauthn_envelope", { alg });
    return false;
  }

  const effectivePayload = opts?.detachedPayload ?? payloadBstr;
  const externalAad = new Uint8Array(0);
  const sigStructure = encodeSigStructure(
    protectedBstr,
    externalAad,
    effectivePayload,
  );

  // What the key actually signed: the Sig_structure for plain ES256, or the
  // challenge-bound assertion bytes for an enveloped WebAuthn certificate.
  let signedBytes = sigStructure;
  if (alg === COSE_ALG_ES256_WEBAUTHN) {
    const assertionBytes = await webauthnEnvelopeSignedBytes(
      envelope,
      sigStructure,
      signature,
      opts,
    );
    if (!assertionBytes) return false;
    signedBytes = assertionBytes;
  }

  let cryptoKey: CryptoKey;
  if (verifyKey instanceof CryptoKey) {
    cryptoKey = verifyKey;
  } else {
    const parsed = verifyKey as ParsedEcPublicKey;
    const uncompressed = new Uint8Array(65);
    uncompressed[0] = 0x04;
    uncompressed.set(parsed.x, 1);
    uncompressed.set(parsed.y, 33);
    try {
      cryptoKey = await crypto.subtle.importKey(
        "raw",
        uncompressed,
        { name: "ECDSA", namedCurve: "P-256" },
        false,
        ["verify"],
      );
    } catch (e) {
      logVerifyFailure(opts, "p256_parsed_verify_threw", {
        error: e instanceof Error ? e.message : String(e),
      });
      return false;
    }
  }

  try {
    const ok = await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      cryptoKey,
      signature as BufferSource,
      signedBytes as BufferSource,
    );
    if (!ok) {
      logVerifyFailure(opts, "ecdsa_verify_false", {
        alg,
        protectedBstrLen: protectedBstr.length,
        payloadBstrLen: payloadBstr.length,
        sigStructureLen: sigStructure.length,
        sigStructureSha256HexPrefix: await sha256HexPrefix16(sigStructure),
        signatureHeadHex: hexPreview(signature, 8),
      });
    }
    return ok;
  } catch (e) {
    logVerifyFailure(opts, "subtle_verify_threw", {
      error: e instanceof Error ? e.message : String(e),
      protectedBstrLen: protectedBstr.length,
      payloadBstrLen: payloadBstr.length,
      sigStructureLen: sigStructure.length,
    });
    return false;
  }
}

/** Parsed components of a COSE Sign1 four-tuple after CBOR decode. */
export interface DecodedCoseSign1 {
  /** COSE Sign1 `[0]` protected header bstr (map bytes inside). */
  protectedBstr: Uint8Array;
  /** COSE Sign1 `[1]` unprotected header (Map or cbor-x object shape). */
  unprotected: unknown;
  /** COSE Sign1 `[2]` payload bstr (empty when detached). */
  payloadBstr: Uint8Array;
  /** COSE Sign1 `[3]` signature bstr. */
  signature: Uint8Array;
}

/**
 * Decode COSE Sign1 bytes to components.
 *
 * @param coseSign1Bytes - CBOR-encoded COSE Sign1
 * @returns Parsed tuple fields, or null when CBOR shape is invalid
 */
export function decodeCoseSign1(
  coseSign1Bytes: Uint8Array,
): DecodedCoseSign1 | null {
  let arr: unknown[];
  try {
    arr = decodeCborUnwrapCose(coseSign1Bytes) as unknown[];
  } catch {
    return null;
  }
  if (!Array.isArray(arr) || arr.length < 4) return null;

  const protectedBstr = arr[0];
  const payloadRaw = arr[2];
  const sig = arr[3];

  if (!(protectedBstr instanceof Uint8Array)) return null;
  const payloadBstr =
    payloadRaw === null || payloadRaw === undefined
      ? new Uint8Array(0)
      : payloadRaw instanceof Uint8Array
        ? payloadRaw
        : null;
  if (payloadBstr === null) return null;
  if (!(sig instanceof Uint8Array)) return null;

  return {
    protectedBstr,
    unprotected: arr[1],
    payloadBstr,
    signature: sig,
  };
}
