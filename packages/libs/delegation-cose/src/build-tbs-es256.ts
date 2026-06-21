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

/** SHA-256(raw P-256 pubkey)[0:16] — ES256 protected header kid. */
export async function deriveEs256KidFromPublicKey(
  publicKey: CryptoKey,
): Promise<Uint8Array> {
  const raw = new Uint8Array(
    (await crypto.subtle.exportKey("raw", publicKey)) as ArrayBuffer,
  );
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", raw));
  return digest.slice(0, 16);
}

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
