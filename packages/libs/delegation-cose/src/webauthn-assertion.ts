/**
 * WebAuthn assertion helpers for ES256_WEBAUTHN delegation proofs (univocity
 * ADR-0008). An authenticator signs `authenticatorData ‖ sha256(clientDataJSON)`
 * with the caller's message reachable only through `clientDataJSON.challenge`,
 * so the proof carries the assertion parts in the generic `algData` array:
 * `[authenticatorData, clientDataJSON, be64(challengeIndex) ‖ be64(typeIndex)]`
 * — the contract's `decodeWebAuthnDelegationAlgData` is normative. The index
 * hints exist to spare Solidity a JSON scan; off-chain assembly derives them
 * from the bytes so they can never disagree with the content.
 */

import { ES256_SIG_BYTES } from "./payload-labels.js";

/** WebAuthn authenticatorData flag bits (WebAuthn L2 §6.1). */
export const WEBAUTHN_FLAG_UP = 0x01;
export const WEBAUTHN_FLAG_UV = 0x04;
export const WEBAUTHN_FLAG_BE = 0x08;
export const WEBAUTHN_FLAG_BS = 0x10;
/** Minimum authenticatorData: rpIdHash (32) ‖ flags (1) ‖ signCount (4). */
export const WEBAUTHN_AUTH_DATA_MIN_BYTES = 37;

/** The exact byte sequences the on-chain verifier slice-compares. */
const TYPE_MARKER = new TextEncoder().encode('"type":"webauthn.get"');
const CHALLENGE_MARKER = new TextEncoder().encode('"challenge":"');

/** Decoded ES256_WEBAUTHN algData elements (ADR-0008 §3). */
export interface WebauthnDelegationAlgData {
  /** Raw authenticatorData (≥ 37 bytes). */
  authenticatorData: Uint8Array;
  /** Raw clientDataJSON bytes as the authenticator hashed them. */
  clientDataJSON: Uint8Array;
  /** Byte offset of `"challenge":"` in clientDataJSON. */
  challengeIndex: bigint;
  /** Byte offset of `"type":"webauthn.get"` in clientDataJSON. */
  typeIndex: bigint;
}

function indexOfBytes(haystack: Uint8Array, needle: Uint8Array): number {
  outer: for (let i = 0; i + needle.length <= haystack.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) continue outer;
    }
    return i;
  }
  return -1;
}

/**
 * Convert an ASN.1 DER ECDSA signature (what `navigator.credentials.get`
 * returns for P-256 credentials) to the 64-byte IEEE P1363 `r ‖ s` form the
 * wire requires. Low-s normalization is a separate step
 * (`normalizeEs256SignatureLowS`) — DER conversion must not silently alter
 * the signature value.
 *
 * @param der - DER `SEQUENCE { INTEGER r, INTEGER s }` bytes
 * @throws When the DER structure is malformed or a component exceeds 32 bytes
 */
export function derSignatureToP1363(der: Uint8Array): Uint8Array {
  let off = 0;
  const need = (n: number): void => {
    if (off + n > der.length) throw new Error("DER signature truncated");
  };
  need(2);
  if (der[off] !== 0x30) throw new Error("DER signature: expected SEQUENCE");
  off += 1;
  // Short or single-byte long form covers every P-256 signature (≤ 70 bytes).
  let seqLen = der[off]!;
  off += 1;
  if (seqLen === 0x81) {
    need(1);
    seqLen = der[off]!;
    off += 1;
  } else if (seqLen > 0x80) {
    throw new Error("DER signature: unsupported length form");
  }
  if (off + seqLen !== der.length) {
    throw new Error("DER signature: length mismatch");
  }

  const readInt = (): Uint8Array => {
    need(2);
    if (der[off] !== 0x02) throw new Error("DER signature: expected INTEGER");
    off += 1;
    const len = der[off]!;
    off += 1;
    if (len === 0 || len > 0x80) {
      throw new Error("DER signature: bad INTEGER length");
    }
    need(len);
    let bytes = der.subarray(off, off + len);
    off += len;
    // Strip the sign-padding zero DER adds when the high bit is set.
    while (bytes.length > 1 && bytes[0] === 0x00) {
      bytes = bytes.subarray(1);
    }
    if (bytes.length > 32) {
      throw new Error("DER signature: component exceeds 32 bytes");
    }
    return bytes;
  };

  const r = readInt();
  const s = readInt();
  if (off !== der.length) throw new Error("DER signature: trailing bytes");

  const out = new Uint8Array(ES256_SIG_BYTES);
  out.set(r, 32 - r.length);
  out.set(s, 64 - s.length);
  return out;
}

/**
 * Locate the `"challenge":"` and `"type":"webauthn.get"` byte offsets the
 * on-chain verifier slice-compares (it never parses JSON at gas prices).
 *
 * @param clientDataJSON - Raw clientDataJSON bytes from the assertion
 * @throws When either marker is absent — such an assertion can never verify
 */
export function locateClientDataIndices(clientDataJSON: Uint8Array): {
  challengeIndex: bigint;
  typeIndex: bigint;
} {
  const typeIndex = indexOfBytes(clientDataJSON, TYPE_MARKER);
  if (typeIndex < 0) {
    throw new Error('clientDataJSON has no "type":"webauthn.get" member');
  }
  const challengeIndex = indexOfBytes(clientDataJSON, CHALLENGE_MARKER);
  if (challengeIndex < 0) {
    throw new Error('clientDataJSON has no "challenge" member');
  }
  return {
    challengeIndex: BigInt(challengeIndex),
    typeIndex: BigInt(typeIndex),
  };
}

/**
 * Assemble the 3-element ES256_WEBAUTHN `algData` array, deriving the index
 * hints from the clientDataJSON bytes (mirror of the contract's normative
 * `decodeWebAuthnDelegationAlgData` layout).
 *
 * @param authenticatorData - Raw authenticatorData from the assertion
 * @param clientDataJSON - Raw clientDataJSON bytes from the assertion
 * @throws When authenticatorData is shorter than 37 bytes or the JSON markers
 *   are absent
 */
export function assembleWebauthnDelegationAlgData(
  authenticatorData: Uint8Array,
  clientDataJSON: Uint8Array,
): Uint8Array[] {
  if (authenticatorData.length < WEBAUTHN_AUTH_DATA_MIN_BYTES) {
    throw new Error(
      `authenticatorData must be at least ${WEBAUTHN_AUTH_DATA_MIN_BYTES} bytes`,
    );
  }
  const { challengeIndex, typeIndex } = locateClientDataIndices(clientDataJSON);
  const indices = new Uint8Array(16);
  const view = new DataView(indices.buffer);
  view.setBigUint64(0, challengeIndex);
  view.setBigUint64(8, typeIndex);
  return [authenticatorData, clientDataJSON, indices];
}

/**
 * Decode an ES256_WEBAUTHN `algData` array, enforcing the same shape rules
 * the contract reverts on (`InvalidWebAuthnAssertion`): exactly 3 elements,
 * authenticatorData ≥ 37 bytes, 16 bytes of packed big-endian indices.
 *
 * @param algData - The proof's `algData` elements
 * @throws When the shape is malformed
 */
export function decodeWebauthnDelegationAlgData(
  algData: readonly Uint8Array[],
): WebauthnDelegationAlgData {
  if (algData.length !== 3) {
    throw new Error("WebAuthn algData must have exactly 3 elements");
  }
  const [authenticatorData, clientDataJSON, indices] = algData as [
    Uint8Array,
    Uint8Array,
    Uint8Array,
  ];
  if (authenticatorData.length < WEBAUTHN_AUTH_DATA_MIN_BYTES) {
    throw new Error(
      `authenticatorData must be at least ${WEBAUTHN_AUTH_DATA_MIN_BYTES} bytes`,
    );
  }
  if (indices.length !== 16) {
    throw new Error("WebAuthn algData indices element must be 16 bytes");
  }
  const view = new DataView(
    indices.buffer,
    indices.byteOffset,
    indices.byteLength,
  );
  return {
    authenticatorData,
    clientDataJSON,
    challengeIndex: view.getBigUint64(0),
    typeIndex: view.getBigUint64(8),
  };
}
