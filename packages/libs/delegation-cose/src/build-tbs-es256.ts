/**
 * ES256 protected-header and TBS construction for delegation certificates.
 * Alg `-7`, cty {@link DELEGATION_CONTENT_TYPE}, kid = truncated SHA-256 of
 * raw P-256 pubkey — same rules as arbor
 * [delegationcert ES256](https://github.com/forestrie/arbor/tree/main/services/pkgs/delegationcert).
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
  COSE_ALG_ES256,
  COSE_HEADER_ALG,
  COSE_HEADER_CTY,
  COSE_HEADER_KID,
} from "./payload-labels.js";

/**
 * Derive the 16-byte ES256 protected-header `kid` from a raw P-256 public key.
 *
 * @param publicKey - Web Crypto EC P-256 public key (exportable as `raw`).
 * @returns First 16 bytes of SHA-256(raw uncompressed point).
 */
export async function deriveEs256KidFromPublicKey(
  publicKey: CryptoKey,
): Promise<Uint8Array> {
  const raw = new Uint8Array(
    (await crypto.subtle.exportKey("raw", publicKey)) as ArrayBuffer,
  );
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", raw));
  return digest.slice(0, 16);
}

/**
 * Build ES256 delegation TBS: protected header, payload, and Sig_structure
 * bytes for root signing.
 *
 * @param input - Delegation scope and delegated public key material.
 * @param rootKid - 16-byte kid placed in protected header label 4.
 */
export function buildDelegationToBeSignedEs256(
  input: DelegationInput,
  rootKid: Uint8Array,
): DelegationToBeSigned {
  if (rootKid.length !== 16) {
    throw new Error("ES256 root kid must be 16 bytes");
  }
  const protectedBytes = encodeIntKeyCbor(
    new Map<number, unknown>([
      [COSE_HEADER_ALG, COSE_ALG_ES256],
      [COSE_HEADER_CTY, DELEGATION_CONTENT_TYPE],
      [COSE_HEADER_KID, rootKid],
    ]),
  );
  const payloadBytes = buildDelegationPayloadBytes(input);
  return buildDelegationToBeSigned(protectedBytes, payloadBytes);
}
