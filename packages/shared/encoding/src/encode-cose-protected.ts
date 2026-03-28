/**
 * COSE protected header primitive: CBOR map with integer keys.
 * Used for statement COSE: protected = bstr containing map { 4: kid } (COSE_KID = 4).
 */

import { encodeCborBstr } from "./encode-cbor-bstr.js";

/** COSE header label for key id (kid). RFC 8152. */
export const COSE_KID = 4;

/**
 * Serialize the COSE protected header map bytes only (not wrapped in an outer bstr).
 * This is the COSE Sign1 `[0]` bstr **payload** and the input expected by
 * `encodeSigStructure` (which wraps it for Sig_structure per RFC 8152).
 */
export function encodeCoseProtectedMapBytes(kid: Uint8Array): Uint8Array {
  return encodeCborMapIntToBstr(COSE_KID, kid);
}

/**
 * Encode protected header as CBOR bstr containing a map with one entry: COSE_KID -> kid.
 * Used in COSE Sign1 statement (protected = bstr with map { 4: kid }).
 */
export function encodeCoseProtectedWithKid(kid: Uint8Array): Uint8Array {
  return encodeCborBstr(encodeCoseProtectedMapBytes(kid));
}

/**
 * Encode a CBOR map with one entry: key (uint) -> value (bstr).
 * Returns the map bytes only (not wrapped in bstr).
 */
function encodeCborMapIntToBstr(
  key: number,
  valueBytes: Uint8Array,
): Uint8Array {
  const mapHeader = new Uint8Array([0xa1]); // map(1)
  const keyByte = new Uint8Array([key]);
  const valueBstr = encodeCborBstr(valueBytes);
  const out = new Uint8Array(
    mapHeader.length + keyByte.length + valueBstr.length,
  );
  out.set(mapHeader, 0);
  out.set(keyByte, mapHeader.length);
  out.set(valueBstr, mapHeader.length + keyByte.length);
  return out;
}
