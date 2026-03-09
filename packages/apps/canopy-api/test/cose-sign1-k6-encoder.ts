/**
 * COSE Sign1 with kid — re-exports canonical encoder from @canopy/encoding.
 * Uses 64-byte placeholder signature to match k6 encoder byte-for-byte (Plan 0003).
 */

import { encodeCoseSign1Statement } from "@canopy/encoding";

/** Placeholder signature length used by k6 (64 bytes). */
const K6_SIGNATURE_PLACEHOLDER_LENGTH = 64;

/**
 * Encode COSE Sign1 with kid in protected header (k6-compatible).
 * Same contract as perf/k6/canopy-api/lib/cose.js encodeCoseSign1WithKid.
 */
export function encodeCoseSign1WithKid(
  payload: Uint8Array,
  kid: Uint8Array,
): Uint8Array {
  const signature = new Uint8Array(K6_SIGNATURE_PLACEHOLDER_LENGTH);
  return encodeCoseSign1Statement(payload, kid, signature);
}
