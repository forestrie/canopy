import { Encoder } from "cbor-x";

const cborEncoder = new Encoder({ mapsAsObjects: false });

/** CBOR-encode values with integer-key maps (Go delegationcert contract). */
export function encodeIntKeyCbor(value: unknown): Uint8Array {
  const encoded = cborEncoder.encode(value);
  return encoded instanceof Uint8Array
    ? encoded
    : new Uint8Array(encoded as ArrayLike<number>);
}
