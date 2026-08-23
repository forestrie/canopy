/**
 * Final COSE_Sign1 assembly for Forestrie delegation certificates. Accepts a
 * pre-built TBS and root signature; wire shape must match arbor
 * [delegationcert](https://github.com/forestrie/arbor/tree/main/services/pkgs/delegationcert).
 * See [plan-0035](https://github.com/forestrie/canopy/blob/main/docs/plans/plan-0035-delegation-cose-library.md).
 */

import type { DelegationToBeSigned } from "./delegation-tbs.js";
import { encodeIntKeyCbor } from "./encode-int-map.js";
import {
  COSE_ALG_ES256_WEBAUTHN,
  ES256_SIG_BYTES,
  KS256_EOA_SIG_BYTES,
} from "./payload-labels.js";
import { WEBAUTHN_AUTH_DATA_MIN_BYTES } from "./webauthn-assertion.js";

/**
 * Wrap protected header, empty unprotected map, payload, and signature into an
 * untagged COSE_Sign1 array per the Forestrie delegation profile.
 *
 * @param tbs - Protected and payload bytes from
 *   {@link buildDelegationToBeSignedEs256} or {@link buildDelegationToBeSignedKs256}.
 * @param signature - 64-byte ES256 (IEEE P1363) or 65-byte KS256 EOA signature
 *   over `tbs.sigStructureBytes`.
 * @returns CBOR-encoded COSE_Sign1 certificate bytes.
 */
export function assembleDelegationCertificate(
  tbs: DelegationToBeSigned,
  signature: Uint8Array,
): Uint8Array {
  if (
    signature.length !== ES256_SIG_BYTES &&
    signature.length !== KS256_EOA_SIG_BYTES
  ) {
    throw new Error(
      `signature must be ${ES256_SIG_BYTES} (ES256) or ${KS256_EOA_SIG_BYTES} (KS256) bytes`,
    );
  }
  return encodeIntKeyCbor([
    tbs.protectedBytes,
    new Map<string, unknown>(),
    tbs.payloadBytes,
    signature,
  ]);
}

/**
 * Wrap an ES256_WEBAUTHN delegation certificate: the assertion envelope
 * `[authenticatorData, clientDataJSON]` rides in the unprotected header at
 * label -65800 (ADR-0063 §2 — no on-chain-style index hints), leaving
 * `Sig_structure` canonical. Trust hinges on the challenge binding the
 * verifier re-derives; the envelope itself is unsigned.
 *
 * @param tbs - Protected and payload bytes from
 *   {@link buildDelegationToBeSignedWebauthn}.
 * @param signature - 64-byte IEEE P1363 `r‖s`, low-s normalized, over
 *   `authenticatorData ‖ sha256(clientDataJSON)`.
 * @param authenticatorData - Raw authenticatorData from the assertion.
 * @param clientDataJSON - Raw clientDataJSON bytes as the authenticator
 *   hashed them.
 * @returns CBOR-encoded COSE_Sign1 certificate bytes.
 */
export function assembleDelegationCertificateWebauthn(
  tbs: DelegationToBeSigned,
  signature: Uint8Array,
  authenticatorData: Uint8Array,
  clientDataJSON: Uint8Array,
): Uint8Array {
  if (signature.length !== ES256_SIG_BYTES) {
    throw new Error(
      `WebAuthn certificate signature must be ${ES256_SIG_BYTES} bytes (raw P1363 r‖s, never a container)`,
    );
  }
  if (authenticatorData.length < WEBAUTHN_AUTH_DATA_MIN_BYTES) {
    throw new Error(
      `authenticatorData must be at least ${WEBAUTHN_AUTH_DATA_MIN_BYTES} bytes`,
    );
  }
  return encodeIntKeyCbor([
    tbs.protectedBytes,
    new Map<number, unknown>([
      [COSE_ALG_ES256_WEBAUTHN, [authenticatorData, clientDataJSON]],
    ]),
    tbs.payloadBytes,
    signature,
  ]);
}
