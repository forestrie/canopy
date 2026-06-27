/**
 * Integer-key CBOR encoding for delegation maps. Uses `mapsAsObjects: false`
 * so numeric keys round-trip like Go `delegationcert` and cbor-x decode in
 * arbor sealer.
 */

import { Encoder } from "cbor-x";

const cborEncoder = new Encoder({ mapsAsObjects: false });

/**
 * CBOR-encode a value preserving integer map keys (not stringified).
 *
 * @param value - Map, array, or primitive acceptable to the Forestrie wire
 *   profile (protected header, payload, or COSE_Sign1 array).
 * @returns Encoded bytes for COSE bstr fields or outer Sign1 array.
 */
export function encodeIntKeyCbor(value: unknown): Uint8Array {
  const encoded = cborEncoder.encode(value);
  return encoded instanceof Uint8Array
    ? encoded
    : new Uint8Array(encoded as ArrayLike<number>);
}
