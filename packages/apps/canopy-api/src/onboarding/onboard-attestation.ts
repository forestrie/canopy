/**
 * Bootstrap-key registrant attestation (devdocs plan-2607-43 slice 06,
 * ADR-0059 D8).
 *
 * The contract's `bootstrapConfig()` key is the only key that can ever
 * produce the instance's first checkpoint — holder-of-bootstrap-key and
 * whose-instance-this-is are the same party by construction. An onboard
 * request carries a COSE_Sign1 whose payload is a CWT (RFC 8392) binding the
 * exact chain binding to a bounded freshness window and this operator's
 * origin, signed by that key. Verifying it closes the squat window (paying
 * to reserve someone else's deployed contract) at the front door.
 *
 * Envelope discipline:
 * - protected `alg` MUST equal the chain-declared `bootstrapAlg` — the trust
 *   anchor comes from the chain, never from the envelope;
 * - protected content type (header 3) MUST be
 *   {@link ONBOARD_ATTESTATION_CONTENT_TYPE} — cross-protocol domain
 *   separation from the bootstrap grant / delegation certificates this key
 *   also signs (their content type differs, so neither verifies as the
 *   other);
 * - KS256 uses the one existing `@forestrie/delegation-cose` profile
 *   (keccak256 over Sig_structure, EOA recovery) — no second convention.
 *
 * Self-contained, no challenge round-trip: the key may be in cold custody,
 * and replay within the window only yields duplicate pending requests for
 * the owner's own instance — the exclusive thing (the reservation) is still
 * won at redeem.
 */

import { p256 } from "@noble/curves/p256";
import { secp256k1 } from "@noble/curves/secp256k1";
import { sha256 } from "@noble/hashes/sha2";
import { keccak_256 } from "@noble/hashes/sha3";
import { decodeCoseSign1Parts } from "@forestrie/delegation-cose";
import {
  decodeCborDeterministic,
  encodeSigStructure,
} from "@forestrie/encoding";
import { COSE_ALG_ES256, COSE_ALG_KS256 } from "./univocity-identity-probe.js";

/** Signed content type — the domain separator for this envelope. */
export const ONBOARD_ATTESTATION_CONTENT_TYPE =
  "application/forestrie-onboard-attestation+cwt";

/** COSE protected header labels (RFC 9052). */
const HDR_ALG = 1;
const HDR_CONTENT_TYPE = 3;

/** CWT claim keys (RFC 8392) + the private chain-binding claim. */
const CLAIM_ISS = 1;
const CLAIM_AUD = 3;
const CLAIM_EXP = 4;
const CLAIM_IAT = 6;
/** Private claim: map {1: chainId tstr, 2: univocityAddr 40-lowerhex tstr}. */
export const CLAIM_CHAIN_BINDING = -70000;
const BINDING_CHAIN_ID = 1;
const BINDING_UNIVOCITY_ADDR = 2;

/** Default ceiling on `exp - iat` — generous for key ceremonies (≤ 24 h). */
export const DEFAULT_ATTESTATION_MAX_WINDOW_SEC = 24 * 60 * 60;
/** Clock-skew tolerance on `iat`. */
const IAT_SKEW_SEC = 300;

export interface BootstrapKeyCwtExpectation {
  /** Chain-declared bootstrap alg (COSE id) — the envelope must match. */
  alg: number;
  /** Chain-declared bootstrap key (ES256: 64-byte x‖y; KS256: 20-byte address). */
  key: Uint8Array;
  chainId: string;
  /** 40-hex lowercase, no 0x. */
  univocityAddr: string;
  /** Accepted `aud` values (operator origin; env override plus request origin). */
  acceptedAud: string[];
  nowSec: number;
  /** Ceiling on the freshness window; default {@link DEFAULT_ATTESTATION_MAX_WINDOW_SEC}. */
  maxWindowSec?: number;
}

export type BootstrapKeyCwtResult =
  | { ok: true; iss: string; aud: string; iat: number; exp: number }
  | { ok: false; detail: string };

function asMap(value: unknown): Map<unknown, unknown> | null {
  return value instanceof Map ? value : null;
}

function mapGetNumber(m: Map<unknown, unknown>, key: number): number | null {
  const v = m.get(key);
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "bigint") {
    const n = Number(v);
    return Number.isSafeInteger(n) ? n : null;
  }
  return null;
}

function mapGetString(m: Map<unknown, unknown>, key: number): string | null {
  const v = m.get(key);
  return typeof v === "string" ? v : null;
}

function verifyEs256(
  sigStructure: Uint8Array,
  signature: Uint8Array,
  keyXY: Uint8Array,
): boolean {
  if (signature.length !== 64 || keyXY.length !== 64) return false;
  const uncompressed = new Uint8Array(65);
  uncompressed[0] = 0x04;
  uncompressed.set(keyXY, 1);
  try {
    return p256.verify(signature, sha256(sigStructure), uncompressed, {
      prehash: false,
      lowS: false,
    });
  } catch {
    return false;
  }
}

function verifyKs256(
  sigStructure: Uint8Array,
  signature: Uint8Array,
  keyAddress: Uint8Array,
): boolean {
  // The delegation-cose KS256 profile: keccak256(Sig_structure), 65-byte
  // r‖s‖v EOA recovery, address comparison.
  if (signature.length !== 65 || keyAddress.length !== 20) return false;
  const hash = keccak_256(sigStructure);
  let v = signature[64]!;
  if (v >= 27) v -= 27;
  if (v > 3) return false;
  try {
    const sig = secp256k1.Signature.fromCompact(
      signature.slice(0, 64),
    ).addRecoveryBit(v);
    const pub = sig.recoverPublicKey(hash).toRawBytes(false);
    const addr = keccak_256(pub.slice(1)).slice(-20);
    if (addr.length !== keyAddress.length) return false;
    for (let i = 0; i < 20; i++) {
      if (addr[i] !== keyAddress[i]) return false;
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Verify a bootstrap-key-signed CWT envelope against chain-derived
 * expectations. `expectedContentType` is the domain separator: each protocol
 * that reuses the D8 pattern (onboarding, the FOR-497 account read) names its
 * own signed content type, so envelopes never verify across protocols.
 *
 * Pure: no I/O, no clock reads — the caller supplies `nowSec` and the
 * chain-probed `(alg, key)` so tests can pin every branch.
 */
export function verifyBootstrapKeyCwt(
  attestation: Uint8Array,
  expected: BootstrapKeyCwtExpectation,
  expectedContentType: string,
): BootstrapKeyCwtResult {
  let parts: ReturnType<typeof decodeCoseSign1Parts>;
  try {
    parts = decodeCoseSign1Parts(attestation);
  } catch (error) {
    return {
      ok: false,
      detail: error instanceof Error ? error.message : "not a COSE_Sign1",
    };
  }

  let header: Map<unknown, unknown> | null;
  try {
    header = asMap(decodeCborDeterministic(parts.protectedBytes));
  } catch {
    header = null;
  }
  if (!header) {
    return { ok: false, detail: "protected header is not a CBOR map" };
  }
  const alg = mapGetNumber(header, HDR_ALG);
  if (alg !== expected.alg) {
    return {
      ok: false,
      detail: `attestation alg ${alg} does not match chain bootstrapAlg ${expected.alg}`,
    };
  }
  const contentType = mapGetString(header, HDR_CONTENT_TYPE);
  if (contentType !== expectedContentType) {
    // Domain separation: a bootstrap grant / delegation certificate signed by
    // the same key carries a different signed content type and must not
    // verify here (and vice versa).
    return { ok: false, detail: "wrong signed content type for attestation" };
  }

  const sigStructure = encodeSigStructure(
    parts.protectedBytes,
    new Uint8Array(0),
    parts.payloadBytes,
  );
  const signatureOk =
    expected.alg === COSE_ALG_ES256
      ? verifyEs256(sigStructure, parts.signature, expected.key)
      : expected.alg === COSE_ALG_KS256
        ? verifyKs256(sigStructure, parts.signature, expected.key)
        : false;
  if (!signatureOk) {
    return { ok: false, detail: "attestation signature invalid" };
  }

  let claims: Map<unknown, unknown> | null;
  try {
    claims = asMap(decodeCborDeterministic(parts.payloadBytes));
  } catch {
    claims = null;
  }
  if (!claims) {
    return { ok: false, detail: "attestation payload is not a CWT claims map" };
  }

  const aud = mapGetString(claims, CLAIM_AUD);
  if (!aud || !expected.acceptedAud.includes(aud)) {
    return {
      ok: false,
      detail: "attestation aud does not name this operator origin",
    };
  }

  const iat = mapGetNumber(claims, CLAIM_IAT);
  const exp = mapGetNumber(claims, CLAIM_EXP);
  if (iat === null || exp === null) {
    return { ok: false, detail: "attestation missing iat/exp" };
  }
  const maxWindow = expected.maxWindowSec ?? DEFAULT_ATTESTATION_MAX_WINDOW_SEC;
  if (iat > expected.nowSec + IAT_SKEW_SEC) {
    return { ok: false, detail: "attestation issued in the future" };
  }
  if (exp <= expected.nowSec) {
    return { ok: false, detail: "attestation expired" };
  }
  if (exp - iat > maxWindow) {
    return {
      ok: false,
      detail: `attestation window exceeds ${maxWindow}s policy ceiling`,
    };
  }

  const binding = asMap(claims.get(CLAIM_CHAIN_BINDING));
  if (!binding) {
    return { ok: false, detail: "attestation missing chainBinding claim" };
  }
  const claimChainId = mapGetString(binding, BINDING_CHAIN_ID);
  const claimAddr = mapGetString(binding, BINDING_UNIVOCITY_ADDR);
  if (
    claimChainId !== expected.chainId ||
    claimAddr?.toLowerCase() !== expected.univocityAddr.toLowerCase()
  ) {
    return {
      ok: false,
      detail: "attestation chainBinding does not match the request",
    };
  }

  // Belt-and-braces: iss carries the CAIP-10 id derived from the same
  // binding — tolerate absence (the binding claim is authoritative) but
  // reject an iss that names a DIFFERENT instance.
  const iss = mapGetString(claims, CLAIM_ISS);
  const expectedIss = `eip155:${expected.chainId}:0x${expected.univocityAddr.toLowerCase()}`;
  if (iss !== null && iss !== expectedIss) {
    return { ok: false, detail: "attestation iss names a different instance" };
  }

  return { ok: true, iss: iss ?? expectedIss, aud, iat, exp };
}

/** Verify an onboard attestation against chain-derived expectations. */
export function verifyOnboardAttestation(
  attestation: Uint8Array,
  expected: BootstrapKeyCwtExpectation,
): BootstrapKeyCwtResult {
  return verifyBootstrapKeyCwt(
    attestation,
    expected,
    ONBOARD_ATTESTATION_CONTENT_TYPE,
  );
}
