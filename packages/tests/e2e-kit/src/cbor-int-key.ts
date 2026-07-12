/**
 * CBOR encoder for integer-key maps (Go fxamacker / delegationcert contract).
 * Avoid bare cbor-x `encode()` which can emit string-key maps.
 */

import { encodeCborDeterministic } from "./encoding/encode-cbor-deterministic.js";

export function cborIntKeyBytes(value: unknown): Uint8Array {
  return encodeCborDeterministic(value);
}
