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
 * {@link encodeSigStructure} (which wraps it for Sig_structure per RFC 8152).
 *
 * @param kid - Key id bytes for COSE header label {@link COSE_KID}
 * @returns CBOR map `{ 4: kid }` as raw bytes
 */
export function encodeCoseProtectedMapBytes(kid: Uint8Array): Uint8Array {
  return encodeCborMapIntToBstr(COSE_KID, kid);
}

/**
 * Encode protected header as CBOR bstr containing `{@link COSE_KID}: kid`.
 * Used as COSE Sign1 `[0]` in statement receipts.
 *
 * @param kid - Signer key id bound in the protected header
 * @returns CBOR bstr wrapping the protected map bytes
 */
export function encodeCoseProtectedWithKid(kid: Uint8Array): Uint8Array {
  return encodeCborBstr(encodeCoseProtectedMapBytes(kid));
}

/** Encode `map(1) { key: bstr(valueBytes) }` without an outer bstr wrapper. */
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
