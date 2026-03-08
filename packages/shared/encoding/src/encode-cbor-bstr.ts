/**
 * CBOR byte string (major type 2) primitive.
 * Single-responsibility: encode a byte string for use in COSE, grant request, etc.
 */

/**
 * Encode bytes as CBOR bstr (major type 2). Returns header + payload.
 */
export function encodeCborBstr(bytes: Uint8Array): Uint8Array {
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
  const out = new Uint8Array(header.length + bytes.length);
  out.set(header, 0);
  out.set(bytes, header.length);
  return out;
}
