/**
 * Cryptographic verification of COSE Sign1 (statement).
 * Single place for verify concern; uses Web Crypto (ES256 / P-256).
 */

import { decode as decodeCbor } from "cbor-x";
import { encodeCborBstr } from "./encode-cbor-bstr.js";
import { encodeSigStructure } from "./encode-sig-structure.js";

/**
 * Verify COSE Sign1 signature with a public key (ES256).
 * Builds Sig_structure per RFC 8152 and verifies ECDSA P-256 (ES256).
 * Signature bstr must be IEEE P1363 R‖S (64 bytes); ASN.1 DER is not COSE ES256.
 *
 * @param coseSign1Bytes - Full COSE Sign1 CBOR bytes (4-element array)
 * @param publicKey - CryptoKey (EC P-256, usage verify)
 * @returns true if signature is valid
 */
export async function verifyCoseSign1(
  coseSign1Bytes: Uint8Array,
  publicKey: CryptoKey,
): Promise<boolean> {
  const decoded = decodeCoseSign1(coseSign1Bytes);
  if (!decoded) return false;

  const { protectedBstr, payloadBstr, signature } = decoded;

  if (signature.length !== 64) return false;

  // Decode gives bstr *content* (map bytes). Sig_structure needs the same bytes
  // as in the message (the full bstr). Re-encode so sign and verify match.
  const protectedBstrForSig = encodeCborBstr(protectedBstr);
  const externalAad = new Uint8Array(0);
  const sigStructure = encodeSigStructure(
    protectedBstrForSig,
    externalAad,
    payloadBstr,
  );

  try {
    return await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      publicKey,
      signature as BufferSource,
      sigStructure as BufferSource,
    );
  } catch {
    return false;
  }
}

export interface DecodedCoseSign1 {
  protectedBstr: Uint8Array;
  unprotected: unknown;
  payloadBstr: Uint8Array;
  signature: Uint8Array;
}

/**
 * Decode COSE Sign1 bytes to components. Returns null if malformed.
 * Signature is returned as raw bytes (for verify); caller must have received bstr in the array.
 */
export function decodeCoseSign1(
  coseSign1Bytes: Uint8Array,
): DecodedCoseSign1 | null {
  let arr: unknown[];
  try {
    arr = decodeCbor(coseSign1Bytes) as unknown[];
  } catch {
    return null;
  }
  if (!Array.isArray(arr) || arr.length < 4) return null;

  const protectedBstr = arr[0];
  const payloadBstr = arr[2];
  const sig = arr[3];

  if (!(protectedBstr instanceof Uint8Array)) return null;
  if (!(payloadBstr instanceof Uint8Array)) return null;
  if (!(sig instanceof Uint8Array)) return null;

  return {
    protectedBstr,
    unprotected: arr[1],
    payloadBstr,
    signature: sig,
  };
}
