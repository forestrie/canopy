import { assembleDelegationCertificate } from "./assemble-certificate.js";
import {
  buildDelegationToBeSignedEs256,
  deriveEs256KidFromPublicKey,
} from "./build-tbs-es256.js";
import type { DelegationInput } from "./delegation-input.js";
import { ES256_SIG_BYTES } from "./payload-labels.js";
import { toArrayBuffer } from "./bytes-utils.js";

export type SignEs256 = (
  sigStructureBytes: Uint8Array,
) => Promise<Uint8Array> | Uint8Array;

export async function buildDelegationCertificateEs256(
  input: DelegationInput,
  rootKeyPair: CryptoKeyPair,
): Promise<Uint8Array> {
  const kid = await deriveEs256KidFromPublicKey(rootKeyPair.publicKey);
  const tbs = buildDelegationToBeSignedEs256(input, kid);
  const signature = new Uint8Array(
    await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      rootKeyPair.privateKey,
      toArrayBuffer(tbs.sigStructureBytes),
    ),
  );
  if (signature.byteLength !== ES256_SIG_BYTES) {
    throw new Error(
      `expected P-256 signature to be ${ES256_SIG_BYTES} bytes, got ${signature.byteLength}`,
    );
  }
  return assembleDelegationCertificate(tbs, signature);
}

export async function buildDelegationCertificateEs256WithSigner(
  input: DelegationInput,
  rootKid: Uint8Array,
  sign: SignEs256,
): Promise<Uint8Array> {
  const tbs = buildDelegationToBeSignedEs256(input, rootKid);
  const signature = await sign(tbs.sigStructureBytes);
  return assembleDelegationCertificate(tbs, signature);
}
