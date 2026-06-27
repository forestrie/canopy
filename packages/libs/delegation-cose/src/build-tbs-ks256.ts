/**
 * KS256 protected-header and TBS construction for delegation certificates.
 * Alg `-65799`, cty {@link DELEGATION_CONTENT_TYPE}, kid = 20-byte root
 * signer address — matches arbor
 * [delegationcert KS256](https://github.com/forestrie/arbor/tree/main/services/pkgs/delegationcert).
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
  COSE_ALG_KS256,
  COSE_HEADER_ALG,
  COSE_HEADER_CTY,
  COSE_HEADER_KID,
} from "./payload-labels.js";

/**
 * Build KS256 delegation TBS: protected header, payload, and Sig_structure
 * bytes for root signing (digest keccak256 at sign/verify time).
 *
 * @param input - Delegation scope and delegated public key material.
 * @param rootSignerAddress - 20-byte Ethereum address for protected header
 *   label 4.
 */
export function buildDelegationToBeSignedKs256(
  input: DelegationInput,
  rootSignerAddress: Uint8Array,
): DelegationToBeSigned {
  if (rootSignerAddress.length !== 20) {
    throw new Error("KS256 root signer address must be 20 bytes");
  }
  const protectedBytes = encodeIntKeyCbor(
    new Map<number, unknown>([
      [COSE_HEADER_ALG, COSE_ALG_KS256],
      [COSE_HEADER_CTY, DELEGATION_CONTENT_TYPE],
      [COSE_HEADER_KID, rootSignerAddress],
    ]),
  );
  const payloadBytes = buildDelegationPayloadBytes(input);
  return buildDelegationToBeSigned(protectedBytes, payloadBytes);
}
