/**
 * Statement COSE encoder (artifact).
 * Produces COSE Sign1 for register-statement: 4-element array; protected = bstr with map { 4: kid }; payload bstr; signature bstr.
 *
 * Wire contract (RFC 8152):
 *   COSE_Sign1 = [ protected: bstr, unprotected: map, payload: bstr, signature: bstr ]
 *   protected decodes to CBOR map with 4 (kid) -> bstr
 *   Signature must be CBOR bstr (not raw bytes in the array).
 */

import { encodeCborBstr } from "./encode-cbor-bstr.js";
import { encodeCoseProtectedWithKid } from "./encode-cose-protected.js";

/**
 * Encode statement COSE Sign1 with kid in protected header.
 * @param payload - Statement payload bytes
 * @param kid - Key id (signer binding; must match grant's signer)
 * @param signature - Signature bytes (will be encoded as CBOR bstr)
 * @returns COSE Sign1 as CBOR-encoded 4-element array
 */
export function encodeCoseSign1Statement(
  payload: Uint8Array,
  kid: Uint8Array,
  signature: Uint8Array,
): Uint8Array {
  const protectedBstr = encodeCoseProtectedWithKid(kid);
  const unprotectedMap = new Uint8Array([0xa0]); // map(0)
  const payloadBstr = encodeCborBstr(payload);
  const signatureBstr = encodeCborBstr(signature);

  const arrayHeader = new Uint8Array([0x84]); // array(4)
  const total =
    arrayHeader.length +
    protectedBstr.length +
    unprotectedMap.length +
    payloadBstr.length +
    signatureBstr.length;
  const out = new Uint8Array(total);
  let off = 0;
  out.set(arrayHeader, off);
  off += arrayHeader.length;
  out.set(protectedBstr, off);
  off += protectedBstr.length;
  out.set(unprotectedMap, off);
  off += unprotectedMap.length;
  out.set(payloadBstr, off);
  off += payloadBstr.length;
  out.set(signatureBstr, off);
  return out;
}
