/**
 * ES256 delegation certificate verification. Confirms the root P-256 key signed
 * the COSE Sig_structure over protected + payload bytes. Sealer performs the
 * same check after fetching material from delegation-coordinator — see
 * [arc checkpoint delegation isolation](https://github.com/forestrie/canopy/blob/main/docs/arc/arc-checkpoint-delegation-isolation.md).
 */

import { encodeSigStructure } from "./encode-sig-structure.js";
import { decodeCoseSign1Parts } from "./parse-delegated-cose-key.js";
import { toArrayBuffer } from "./bytes-utils.js";
import { ES256_SIG_BYTES } from "./payload-labels.js";

/**
 * Verify an ES256 delegation certificate against the expected log root public
 * key.
 *
 * @param certificate - CBOR COSE_Sign1 bytes from coordinator or BYOK upload.
 * @param rootPublicKey - Trusted root P-256 key (from univocity public-root or
 *   operator config).
 * @returns `true` when signature is valid IEEE P1363 over Sig_structure.
 */
export async function verifyDelegationCertificateEs256(
  certificate: Uint8Array,
  rootPublicKey: CryptoKey,
): Promise<boolean> {
  const { protectedBytes, payloadBytes, signature } =
    decodeCoseSign1Parts(certificate);
  if (signature.length !== ES256_SIG_BYTES) {
    return false;
  }
  const sigStructureBytes = encodeSigStructure(
    protectedBytes,
    new Uint8Array(),
    payloadBytes,
  );
  return crypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    rootPublicKey,
    toArrayBuffer(signature),
    toArrayBuffer(sigStructureBytes),
  );
}
