import { encodeSigStructure } from "./encode-sig-structure.js";
import { decodeCoseSign1Parts } from "./parse-delegated-cose-key.js";
import { toArrayBuffer } from "./bytes-utils.js";
import { ES256_SIG_BYTES } from "./payload-labels.js";

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
