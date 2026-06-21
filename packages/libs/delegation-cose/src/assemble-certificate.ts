import type { DelegationToBeSigned } from "./delegation-tbs.js";
import { encodeIntKeyCbor } from "./encode-int-map.js";
import { ES256_SIG_BYTES, KS256_EOA_SIG_BYTES } from "./payload-labels.js";

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
