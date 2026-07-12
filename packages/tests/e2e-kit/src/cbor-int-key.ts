/**
 * CBOR encoder for integer-key maps (Go fxamacker / delegationcert contract).
 * Deterministic RFC 8949 §4.2 encoding via @forestrie/encoding.
 */

import { encodeCborDeterministic } from "@forestrie/encoding";

export function cborIntKeyBytes(value: unknown): Uint8Array {
  return encodeCborDeterministic(value);
}
