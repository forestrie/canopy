/**
 * Encode COSE Sign1 as a CBOR four-tuple:
 * [ protected: bstr, unprotected: map, payload: bstr, signature: bstr ].
 * Used by Custodian-style Sign1 (digest payload, map unprotected) and merge helpers.
 */

import { encode as encodeCbor } from "cbor-x";

/**
 * Serialize a COSE Sign1 four-tuple via cbor-x.
 *
 * @param protectedBstr - COSE Sign1 `[0]` protected header bstr
 * @param unprotected - COSE Sign1 `[1]` unprotected header map
 * @param payloadBstr - COSE Sign1 `[2]` payload bstr (may be empty)
 * @param signature - COSE Sign1 `[3]` signature bstr (IEEE P1363 for ES256)
 * @returns CBOR-encoded COSE Sign1 bytes
 */
export function encodeCoseSign1Raw(
  protectedBstr: Uint8Array,
  unprotected: Map<number, unknown>,
  payloadBstr: Uint8Array,
  signature: Uint8Array,
): Uint8Array {
  const tuple = [protectedBstr, unprotected, payloadBstr, signature];
  return new Uint8Array(encodeCbor(tuple));
}
