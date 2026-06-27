/**
 * Final COSE_Sign1 assembly for Forestrie delegation certificates. Accepts a
 * pre-built TBS and root signature; wire shape must match arbor
 * [delegationcert](https://github.com/forestrie/arbor/tree/main/services/pkgs/delegationcert).
 * See [plan-0035](https://github.com/forestrie/canopy/blob/main/docs/plans/plan-0035-delegation-cose-library.md).
 */

import type { DelegationToBeSigned } from "./delegation-tbs.js";
import { encodeIntKeyCbor } from "./encode-int-map.js";
import { ES256_SIG_BYTES, KS256_EOA_SIG_BYTES } from "./payload-labels.js";

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
