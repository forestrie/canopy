/**
 * ES256 delegation certificate builders. Root signing uses Web Crypto ECDSA
 * over `Sig_structure` (SHA-256 digest); protected header `kid` is 16-byte
 * `SHA-256(raw P-256 pubkey)[0:16]`. Matches arbor ES256 path in
 * [delegationcert](https://github.com/forestrie/arbor/tree/main/services/pkgs/delegationcert).
 */

import { assembleDelegationCertificate } from "./assemble-certificate.js";
import {
  buildDelegationToBeSignedEs256,
  deriveEs256KidFromPublicKey,
} from "./build-tbs-es256.js";
import type { DelegationInput } from "./delegation-input.js";
import { ES256_SIG_BYTES } from "./payload-labels.js";
import { toArrayBuffer } from "./bytes-utils.js";

/**
 * Callback that signs the COSE Sig_structure bytes with an ES256 root key held
 * outside this library (KMS, HSM, or mandate agent).
 */
export type SignEs256 = (
  sigStructureBytes: Uint8Array,
) => Promise<Uint8Array> | Uint8Array;

/**
 * Build a complete ES256 delegation certificate using an in-process root
 * {@link CryptoKeyPair} (tests and local tooling).
 *
 * @param input - Delegation scope and delegated public key material.
 * @param rootKeyPair - P-256 root key that authorizes the delegation.
 * @returns Assembled COSE_Sign1 certificate bytes.
 */
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

/**
 * Build an ES256 delegation certificate when the root signs externally over
 * `tbs.sigStructureBytes` (delegation-coordinator KMS / BYOK upload path).
 *
 * @param input - Delegation scope and delegated public key material.
 * @param rootKid - 16-byte protected-header kid matching the signing root.
 * @param sign - Signs the Sig_structure; must return 64-byte IEEE P1363.
 */
export async function buildDelegationCertificateEs256WithSigner(
  input: DelegationInput,
  rootKid: Uint8Array,
  sign: SignEs256,
): Promise<Uint8Array> {
  const tbs = buildDelegationToBeSignedEs256(input, rootKid);
  const signature = await sign(tbs.sigStructureBytes);
  return assembleDelegationCertificate(tbs, signature);
}
