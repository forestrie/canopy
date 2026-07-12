/**
 * Integer-key CBOR encoding for delegation maps. Uses canonical
 * (deterministic RFC 8949 §4.2) encoding so numeric keys round-trip like Go
 * `delegationcert` and the deterministic decoder in arbor sealer.
 */

import { encodeCborDeterministic } from "@forestrie/encoding";

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
