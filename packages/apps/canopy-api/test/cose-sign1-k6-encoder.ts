/**
 * Minimal COSE Sign1 encoder that matches the k6 encoder byte-for-byte.
 * Used to reproduce and test the sign/verify and encode/decode behaviour
 * without running k6. See perf/k6/canopy-api/lib/cose.js (encodeCoseSign1WithKid)
 * and lib/cbor.js for the reference implementation.
 *
 * COSE Sign1 (RFC 8152): [ protected, unprotected, payload, signature ]
 * - protected: bstr containing CBOR map { 4: kid } (COSE_KID = 4)
 * - unprotected: empty map {}
 * - payload: bstr
 * - signature: 64 bytes (placeholder for load testing)
 */

const COSE_KID = 4;

function concat(...arrays: Uint8Array[]): Uint8Array {
  const total = arrays.reduce((sum, a) => sum + a.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const a of arrays) {
    out.set(a, offset);
    offset += a.length;
  }
  return out;
}

function encodeBstr(bytes: Uint8Array): Uint8Array {
  const len = bytes.length;
  let header: Uint8Array;
  if (len < 24) {
    header = new Uint8Array([0x40 + len]);
  } else if (len < 256) {
    header = new Uint8Array([0x58, len]);
  } else if (len < 65536) {
    header = new Uint8Array([0x59, (len >> 8) & 0xff, len & 0xff]);
  } else {
    header = new Uint8Array([
      0x5a,
      (len >> 24) & 0xff,
      (len >> 16) & 0xff,
      (len >> 8) & 0xff,
      len & 0xff,
    ]);
  }
  return concat(header, bytes);
}

/**
 * Encode a CBOR map with one entry: key (uint) -> value (bstr).
 * Same as k6 encodeCborMapWithBstrValue: 0xa1 + key_byte + bstr(value).
 */
function encodeCborMapWithBstrValue(
  key: number,
  valueBytes: Uint8Array,
): Uint8Array {
  const mapHeader = new Uint8Array([0xa1]);
  const keyByte = new Uint8Array([key]);
  const valueBstr = encodeBstr(valueBytes);
  return concat(mapHeader, keyByte, valueBstr);
}

/**
 * Encode COSE Sign1 with kid in protected header (k6-compatible).
 * Server matches kid to grant signer; signature is 64 placeholder bytes.
 * All four elements must be CBOR-encoded; signature is bstr(64).
 */
export function encodeCoseSign1WithKid(
  payload: Uint8Array,
  kid: Uint8Array,
): Uint8Array {
  const arrayHeader = new Uint8Array([0x84]); // array(4)
  const protectedMap = encodeCborMapWithBstrValue(COSE_KID, kid);
  const protectedBstr = encodeBstr(protectedMap);
  const unprotectedHeaders = new Uint8Array([0xa0]); // map(0)
  const payloadBstr = encodeBstr(payload);
  const signature = new Uint8Array(64);
  const signatureBstr = encodeBstr(signature);
  return concat(
    arrayHeader,
    protectedBstr,
    unprotectedHeaders,
    payloadBstr,
    signatureBstr,
  );
}
