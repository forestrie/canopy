/**
 * Encode COSE Sign1 as a CBOR four-tuple:
 * [ protected: bstr, unprotected: map, payload: bstr, signature: bstr ].
 * Used by Custodian-style Sign1 (digest payload, map unprotected) and merge helpers.
 */

import { encode as encodeCbor } from "cbor-x";

export function encodeCoseSign1Raw(
  protectedBstr: Uint8Array,
  unprotected: Map<number, unknown>,
  payloadBstr: Uint8Array,
  signature: Uint8Array,
): Uint8Array {
  const tuple = [protectedBstr, unprotected, payloadBstr, signature];
  return new Uint8Array(encodeCbor(tuple));
}
