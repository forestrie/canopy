/**
 * COSE Sign1 encoder for k6.
 *
 * Generates COSE Sign1 messages compatible with the SCRAPI /entries endpoint.
 * Uses empty protected headers, unprotected headers, and signature for load
 * testing (same structure as scripts/gen-cose-sign1.mjs).
 *
 * COSE Sign1 structure (RFC 8152):
 * [
 *   protected: bstr (empty),
 *   unprotected: {} (empty map),
 *   payload: bstr,
 *   signature: bstr (empty for testing)
 * ]
 *
 * Reference: RFC 8152 (COSE), RFC 9052 (COSE Structures)
 */

import {
  encodeArrayHeader,
  encodeBstr,
  encodeEmptyMap,
  concat,
  stringToBytes,
} from "./cbor.js";

/**
 * Generate a COSE Sign1 message with the given payload.
 * @param {Uint8Array} payload - The payload bytes
 * @returns {Uint8Array} - CBOR-encoded COSE Sign1 message
 */
export function encodeCoseSign1(payload) {
  // COSE Sign1 is a CBOR array of 4 elements
  const arrayHeader = encodeArrayHeader(4);

  // protected: empty bstr
  const protectedHeaders = new Uint8Array([0x40]);

  // unprotected: empty map
  const unprotectedHeaders = encodeEmptyMap();

  // payload: bstr containing the message
  const payloadBstr = encodeBstr(payload);

  // signature: empty bstr (for testing)
  const signature = new Uint8Array([0x40]);

  return concat(
    arrayHeader,
    protectedHeaders,
    unprotectedHeaders,
    payloadBstr,
    signature
  );
}

/**
 * Generate a COSE Sign1 message with a string payload.
 * @param {string} message - The message string
 * @returns {Uint8Array} - CBOR-encoded COSE Sign1 message
 */
export function encodeCoseSign1String(message) {
  return encodeCoseSign1(stringToBytes(message));
}

/**
 * Generate a COSE Sign1 message with a unique payload.
 * Uses a counter and timestamp to ensure uniqueness.
 * @param {number} counter - A counter value for uniqueness
 * @param {number} [size=64] - Target payload size in bytes
 * @returns {Uint8Array} - CBOR-encoded COSE Sign1 message
 */
export function generateUniquePayload(counter, size = 64) {
  // Create a unique message with timestamp and counter
  const timestamp = Date.now();
  const prefix = `k6-${timestamp}-${counter}-`;
  const prefixBytes = stringToBytes(prefix);

  // Pad to target size if needed
  let payload;
  if (prefixBytes.length >= size) {
    payload = prefixBytes.slice(0, size);
  } else {
    payload = new Uint8Array(size);
    payload.set(prefixBytes, 0);
    // Fill remainder with counter-based bytes for variety
    for (let i = prefixBytes.length; i < size; i++) {
      payload[i] = (counter + i) & 0xff;
    }
  }

  return encodeCoseSign1(payload);
}
