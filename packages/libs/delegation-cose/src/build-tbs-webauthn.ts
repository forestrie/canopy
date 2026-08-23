/**
 * ES256_WEBAUTHN protected-header and TBS construction for delegation
 * certificates (devdocs ADR-0063). Alg `-65800`, cty
 * {@link DELEGATION_CONTENT_TYPE}, kid = truncated SHA-256 of the raw P-256
 * root pubkey — the same profile as the ES256 path; only the alg differs, so
 * an unaware verifier rejects rather than attempting a plain verify.
 */

import { DELEGATION_CONTENT_TYPE } from "./delegation-content-type.js";
import type { DelegationInput } from "./delegation-input.js";
import type { DelegationToBeSigned } from "./delegation-tbs.js";
import {
  buildDelegationPayloadBytes,
  buildDelegationToBeSigned,
} from "./build-delegation-payload.js";
import { encodeIntKeyCbor } from "./encode-int-map.js";
import {
  COSE_ALG_ES256_WEBAUTHN,
  COSE_HEADER_ALG,
  COSE_HEADER_CTY,
  COSE_HEADER_KID,
} from "./payload-labels.js";

/**
 * Build the ES256_WEBAUTHN delegation certificate TBS: protected header,
 * payload, and the Sig_structure bytes whose SHA-256 the ceremony must present
 * as `clientDataJSON.challenge` (base64url-encoded) to
 * `navigator.credentials.get` (ADR-0063 §3).
 *
 * @param input - Delegation scope and delegated public key material.
 * @param rootKid - 16-byte kid placed in protected header label 4 (derive via
 *   {@link deriveEs256KidFromPublicKey} — a passkey root is the same P-256
 *   key material).
 */
export function buildDelegationToBeSignedWebauthn(
  input: DelegationInput,
  rootKid: Uint8Array,
): DelegationToBeSigned {
  if (rootKid.length !== 16) {
    throw new Error("WebAuthn root kid must be 16 bytes");
  }
  const protectedBytes = encodeIntKeyCbor(
    new Map<number, unknown>([
      [COSE_HEADER_ALG, COSE_ALG_ES256_WEBAUTHN],
      [COSE_HEADER_CTY, DELEGATION_CONTENT_TYPE],
      [COSE_HEADER_KID, rootKid],
    ]),
  );
  const payloadBytes = buildDelegationPayloadBytes(input);
  return buildDelegationToBeSigned(protectedBytes, payloadBytes);
}
