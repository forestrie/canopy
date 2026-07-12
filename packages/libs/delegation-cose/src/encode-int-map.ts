/**
 * Integer-key CBOR encoding for delegation maps. Emits strict, tag-free,
 * RFC 8949 §4.2 core-deterministic CBOR (bytewise-sorted keys) via the bespoke
 * {@link encodeCborDeterministic} writer — byte-for-byte identical to Go
 * `delegationcert` (`cbor.SortCoreDeterministic`) so the arbor sealer and the
 * delegation-coordinator parse and sign the same bytes.
 *
 * Previously used `cbor-x` `Encoder({ mapsAsObjects:false })`, which tag-64
 * wraps every `Uint8Array` value (kid, delegation id, key coordinates) — a
 * non-conformant encoding a strict COSE/SCITT verifier rejects (see
 * status-2607-03-remove-cbor-x-for-scitt-cose-canonicity).
 */

import { encodeCborDeterministic } from "./encode-cbor-deterministic.js";

/**
 * CBOR-encode a value preserving integer map keys (not stringified).
 *
 * @param value - Map, array, or primitive acceptable to the Forestrie wire
 *   profile (protected header, payload, or COSE_Sign1 array).
 * @returns Encoded bytes for COSE bstr fields or outer Sign1 array.
 */
export function encodeIntKeyCbor(value: unknown): Uint8Array {
  return encodeCborDeterministic(value);
}
