/**
 * Minimal CBOR encoder for k6.
 *
 * k6 uses goja (Go-based JS runtime) which lacks Node.js Buffer.
 * This module provides CBOR encoding using TypedArrays.
 *
 * Supports:
 * - Major type 0: unsigned integers (0-65535)
 * - Major type 2: byte strings (bstr)
 * - Major type 4: arrays
 * - Major type 5: maps (limited)
 *
 * Reference: RFC 8949 (CBOR)
 */

/**
 * Encode an unsigned integer (major type 0).
 * @param {number} n - Non-negative integer (0 to 2^32-1)
 * @returns {Uint8Array}
 */
export function encodeUint(n) {
  if (n < 0) {
    throw new Error(`encodeUint: negative value ${n}`);
  }
  if (n < 24) {
    return new Uint8Array([n]);
  }
  if (n < 256) {
    return new Uint8Array([0x18, n]);
  }
  if (n < 65536) {
    return new Uint8Array([0x19, (n >> 8) & 0xff, n & 0xff]);
  }
  if (n < 4294967296) {
    return new Uint8Array([
      0x1a,
      (n >> 24) & 0xff,
      (n >> 16) & 0xff,
      (n >> 8) & 0xff,
      n & 0xff,
    ]);
  }
  throw new Error(`encodeUint: value too large ${n}`);
}

/**
 * Encode a byte string header (major type 2).
 * @param {number} length - Length of the byte string
 * @returns {Uint8Array}
 */
export function encodeBstrHeader(length) {
  if (length < 24) {
    return new Uint8Array([0x40 + length]);
  }
  if (length < 256) {
    return new Uint8Array([0x58, length]);
  }
  if (length < 65536) {
    return new Uint8Array([0x59, (length >> 8) & 0xff, length & 0xff]);
  }
  if (length < 4294967296) {
    return new Uint8Array([
      0x5a,
      (length >> 24) & 0xff,
      (length >> 16) & 0xff,
      (length >> 8) & 0xff,
      length & 0xff,
    ]);
  }
  throw new Error(`encodeBstrHeader: length too large ${length}`);
}

/**
 * Encode a byte string (major type 2).
 * @param {Uint8Array} bytes - The byte string to encode
 * @returns {Uint8Array}
 */
export function encodeBstr(bytes) {
  const header = encodeBstrHeader(bytes.length);
  return concat(header, bytes);
}

/**
 * Encode an array header (major type 4).
 * @param {number} length - Number of items in the array
 * @returns {Uint8Array}
 */
export function encodeArrayHeader(length) {
  if (length < 24) {
    return new Uint8Array([0x80 + length]);
  }
  if (length < 256) {
    return new Uint8Array([0x98, length]);
  }
  if (length < 65536) {
    return new Uint8Array([0x99, (length >> 8) & 0xff, length & 0xff]);
  }
  throw new Error(`encodeArrayHeader: length too large ${length}`);
}

/**
 * Encode an empty map (major type 5).
 * @returns {Uint8Array}
 */
export function encodeEmptyMap() {
  return new Uint8Array([0xa0]);
}

/**
 * Concatenate multiple Uint8Arrays.
 * @param {...Uint8Array} arrays - Arrays to concatenate
 * @returns {Uint8Array}
 */
export function concat(...arrays) {
  const totalLength = arrays.reduce((sum, arr) => sum + arr.length, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const arr of arrays) {
    result.set(arr, offset);
    offset += arr.length;
  }
  return result;
}

/**
 * Convert a string to UTF-8 bytes.
 * k6's goja runtime does not have TextEncoder, so we implement manually.
 * @param {string} str - String to convert
 * @returns {Uint8Array}
 */
export function stringToBytes(str) {
  // Manual UTF-8 encoding since k6 lacks TextEncoder
  const bytes = [];
  for (let i = 0; i < str.length; i++) {
    let code = str.charCodeAt(i);
    if (code < 0x80) {
      bytes.push(code);
    } else if (code < 0x800) {
      bytes.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
    } else if (code >= 0xd800 && code < 0xdc00) {
      // Surrogate pair
      i++;
      const low = str.charCodeAt(i);
      code = 0x10000 + ((code - 0xd800) << 10) + (low - 0xdc00);
      bytes.push(
        0xf0 | (code >> 18),
        0x80 | ((code >> 12) & 0x3f),
        0x80 | ((code >> 6) & 0x3f),
        0x80 | (code & 0x3f)
      );
    } else {
      bytes.push(
        0xe0 | (code >> 12),
        0x80 | ((code >> 6) & 0x3f),
        0x80 | (code & 0x3f)
      );
    }
  }
  return new Uint8Array(bytes);
}
