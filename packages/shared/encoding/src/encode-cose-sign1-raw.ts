/**
 * Encode COSE Sign1 as a CBOR four-tuple:
 * [ protected: bstr, unprotected: map, payload: bstr, signature: bstr ].
 * Used by Custodian-style Sign1 (digest payload, map unprotected) and merge helpers.
 */

import { encodeCborDeterministic } from "./encode-cbor-deterministic.js";

/**
 * Serialize a COSE Sign1 four-tuple as strict, tag-free, RFC 8949 §4.2
 * deterministic CBOR (RFC 9052 COSE_Sign1). Emits a plain untagged
 * `array(4)` of `bstr, map, bstr, bstr` — no cbor-x typed-array (tag 64) or
 * map (tag 259) extensions, which strict COSE/SCITT decoders reject (see
 * status-2607-03-remove-cbor-x-for-scitt-cose-canonicity).
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
  return encodeCborDeterministic([
    protectedBstr,
    unprotected,
    payloadBstr,
    signature,
  ]);
}
