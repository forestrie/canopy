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
