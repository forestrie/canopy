/**
 * Sign COSE Sign1 statement (one place for sign concern).
 * Builds Sig_structure per RFC 8152 and signs with ES256 (P-256).
 */

import { encodeCoseProtectedWithKid } from "./encode-cose-protected.js";
import { encodeCoseSign1Statement } from "./encode-cose-sign1-statement.js";
import { encodeSigStructure } from "./encode-sig-structure.js";

/**
 * Sign a statement and produce COSE Sign1 bytes (ES256).
 *
 * @param payload - Statement payload bytes
 * @param kid - Key id (signer binding)
 * @param privateKey - CryptoKey (EC P-256, usage sign)
 * @returns COSE Sign1 bytes
 */
export async function signCoseSign1Statement(
  payload: Uint8Array,
  kid: Uint8Array,
  privateKey: CryptoKey,
): Promise<Uint8Array> {
  const protectedBstr = encodeCoseProtectedWithKid(kid);
  const externalAad = new Uint8Array(0);

  const sigStructureBytes = encodeSigStructure(
    protectedBstr,
    externalAad,
    payload,
  );

  const sigBuffer = sigStructureBytes.buffer.slice(
    sigStructureBytes.byteOffset,
    sigStructureBytes.byteOffset + sigStructureBytes.byteLength,
  ) as ArrayBuffer;
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    privateKey,
    sigBuffer,
  );

  return encodeCoseSign1Statement(payload, kid, new Uint8Array(signature));
}
