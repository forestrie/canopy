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

/** COSE header label for key id (kid). */
const COSE_KID = 4;

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
 * Generate a COSE Sign1 message with kid in protected header (for grant-based auth).
 * Server matches kid to grant signer; signature can be placeholder for load testing.
 * @param {Uint8Array} payload - The payload bytes
 * @param {Uint8Array} kid - Key id (signer binding, must match grant's signer)
 * @returns {Uint8Array} - CBOR-encoded COSE Sign1 message
 */
export function encodeCoseSign1WithKid(payload, kid) {
  const arrayHeader = encodeArrayHeader(4);
  // protected: bstr containing CBOR map { 4: kid }
  const protectedMap = encodeCborMapWithBstrValue(COSE_KID, kid);
  const protectedBstr = encodeBstr(protectedMap);
  const unprotectedHeaders = encodeEmptyMap();
  const payloadBstr = encodeBstr(payload);
  const signature = new Uint8Array(64); // placeholder 64 bytes
  const signatureBstr = encodeBstr(signature);
  return concat(
    arrayHeader,
    protectedBstr,
    unprotectedHeaders,
    payloadBstr,
    signatureBstr
  );
}

/**
 * Encode a CBOR map with one entry: key (uint) -> value (bstr).
 * Used for protected header { 4: kid }. Returns map bytes (0xa1 + key + bstr(value)).
 */
function encodeCborMapWithBstrValue(key, valueBytes) {
  const mapHeader = new Uint8Array([0xa1]); // map(1)
  const keyByte = new Uint8Array([key]);
  const valueBstr = encodeBstr(valueBytes);
  return concat(mapHeader, keyByte, valueBstr);
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
 * Build unique payload bytes (for use with encodeCoseSign1 or encodeCoseSign1WithKid).
 * @param {number} counter - A counter value for uniqueness
 * @param {number} [size=64] - Target payload size in bytes
 * @returns {Uint8Array} - Raw payload bytes
 */
export function generateUniquePayloadBytes(counter, size = 64) {
  const timestamp = Date.now();
  const prefix = `k6-${timestamp}-${counter}-`;
  const prefixBytes = stringToBytes(prefix);

  if (prefixBytes.length >= size) {
    return prefixBytes.slice(0, size);
  }
  const payload = new Uint8Array(size);
  payload.set(prefixBytes, 0);
  for (let i = prefixBytes.length; i < size; i++) {
    payload[i] = (counter + i) & 0xff;
  }
  return payload;
}

/**
 * Generate a COSE Sign1 message with a unique payload (no kid).
 * @param {number} counter - A counter value for uniqueness
 * @param {number} [size=64] - Target payload size in bytes
 * @returns {Uint8Array} - CBOR-encoded COSE Sign1 message
 */
export function generateUniquePayload(counter, size = 64) {
  return encodeCoseSign1(generateUniquePayloadBytes(counter, size));
}
