/**
 * ES256_WEBAUTHN delegation certificate builder (devdocs ADR-0063). A WebAuthn
 * authenticator cannot sign arbitrary bytes — it signs
 * `authenticatorData ‖ sha256(clientDataJSON)` with the caller's message
 * reachable only through `clientDataJSON.challenge` — so the root signs via an
 * async assertion callback, never a drop-in Sig_structure signer: the builder
 * hands the callback the 32-byte challenge (`sha256(Sig_structure)`) and the
 * callback drives the ceremony (`navigator.credentials.get` in a browser, a
 * synthetic authenticator in tests).
 */

import { assembleDelegationCertificateWebauthn } from "./assemble-certificate.js";
import { buildDelegationToBeSignedWebauthn } from "./build-tbs-webauthn.js";
import type { DelegationInput } from "./delegation-input.js";
import { toArrayBuffer } from "./bytes-utils.js";

/** Assertion parts returned by a {@link SignWebauthnAssertion} callback. */
export interface WebauthnAssertionResult {
  /** Raw authenticatorData from the assertion (≥ 37 bytes). */
  authenticatorData: Uint8Array;
  /** Raw clientDataJSON bytes as the authenticator hashed them; its
   * `challenge` member must be the base64url of the callback's input. */
  clientDataJSON: Uint8Array;
  /**
   * 64-byte IEEE P1363 `r‖s`, low-s normalized (convert an authenticator's
   * DER via `derSignatureToP1363` + `normalizeEs256SignatureLowS`).
   */
  signature: Uint8Array;
}

/**
 * Callback that performs the WebAuthn assertion ceremony for a 32-byte
 * challenge (the SHA-256 of the certificate's Sig_structure).
 */
export type SignWebauthnAssertion = (
  challenge: Uint8Array,
) => Promise<WebauthnAssertionResult> | WebauthnAssertionResult;

/**
 * Build a complete ES256_WEBAUTHN delegation certificate: TBS, challenge,
 * assertion ceremony, and envelope assembly (ADR-0063 §2–§3).
 *
 * @param input - Delegation scope and delegated public key material.
 * @param rootKid - 16-byte protected-header kid for the P-256 root credential.
 * @param getAssertion - Performs the ceremony over the derived challenge.
 * @returns Assembled COSE_Sign1 certificate bytes with the assertion envelope
 *   in the unprotected header.
 */
export async function buildDelegationCertificateWebauthn(
  input: DelegationInput,
  rootKid: Uint8Array,
  getAssertion: SignWebauthnAssertion,
): Promise<Uint8Array> {
  const tbs = buildDelegationToBeSignedWebauthn(input, rootKid);
  const challenge = new Uint8Array(
    await crypto.subtle.digest("SHA-256", toArrayBuffer(tbs.sigStructureBytes)),
  );
  const assertion = await getAssertion(challenge);
  return assembleDelegationCertificateWebauthn(
    tbs,
    assertion.signature,
    assertion.authenticatorData,
    assertion.clientDataJSON,
  );
}
