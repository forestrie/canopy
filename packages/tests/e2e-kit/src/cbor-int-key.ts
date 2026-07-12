/**
 * CBOR encoder for integer-key maps (Go fxamacker / delegationcert contract).
 * Avoid bare cbor-x `encode()` which can emit string-key maps.
 */

import { encodeCborDeterministic } from "@forestrie/encoding";

export function cborIntKeyBytes(value: unknown): Uint8Array {
  return encodeCborDeterministic(value);
}
