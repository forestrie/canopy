/**
 * ASN.1 DER ECDSA (SEQUENCE of two INTEGERs) → IEEE P1363 r||s (fixed width).
 * Cloud KMS / Go stacks often emit DER; Web Crypto verify expects raw P-256 (32+32).
 */

function readDerLength(
  bytes: Uint8Array,
  offset: number,
): { length: number; bytesUsed: number } {
  const first = bytes[offset];
  if (first === undefined) throw new Error("DER length read out of range");
  if (first < 0x80) {
    return { length: first, bytesUsed: 1 };
  }
  const numBytes = first & 0x7f;
  if (numBytes === 0 || numBytes > 4) {
    throw new Error("unsupported DER length encoding");
  }
  let len = 0;
  for (let i = 0; i < numBytes; i++) {
    const b = bytes[offset + 1 + i];
    if (b === undefined) throw new Error("DER length truncated");
    len = (len << 8) | b;
  }
  return { length: len, bytesUsed: 1 + numBytes };
}

function toFixedWidthUnsigned(intBytes: Uint8Array, width: number): Uint8Array {
  let start = 0;
  while (start < intBytes.length - 1 && intBytes[start] === 0x00) {
    start++;
  }
  const raw = intBytes.slice(start);
  if (raw.length > width) {
    throw new Error(`INTEGER too large (${raw.length}) for width ${width}`);
  }
  const out = new Uint8Array(width);
  out.set(raw, width - raw.length);
  return out;
}

/**
 * @param der - DER ECDSA signature bytes
 * @param width - coordinate size (32 for P-256)
 */
export function derEcdsaToRawRs(
  der: Uint8Array,
  width: number = 32,
): Uint8Array {
  if (der.length < 8) throw new Error("DER signature too short");
  let offset = 0;

  if (der[offset++] !== 0x30) throw new Error("expected DER SEQUENCE");
  const seqLen = readDerLength(der, offset);
  offset += seqLen.bytesUsed;
  const seqEnd = offset + seqLen.length;
  if (seqEnd > der.length) throw new Error("DER sequence length out of bounds");

  if (der[offset++] !== 0x02) throw new Error("expected INTEGER (r)");
  const rLen = readDerLength(der, offset);
  offset += rLen.bytesUsed;
  const rBytes = der.slice(offset, offset + rLen.length);
  offset += rLen.length;

  if (der[offset++] !== 0x02) throw new Error("expected INTEGER (s)");
  const sLen = readDerLength(der, offset);
  offset += sLen.bytesUsed;
  const sBytes = der.slice(offset, offset + sLen.length);
  offset += sLen.length;

  if (offset !== seqEnd) {
    throw new Error("unexpected trailing data in DER signature");
  }

  const rFixed = toFixedWidthUnsigned(rBytes, width);
  const sFixed = toFixedWidthUnsigned(sBytes, width);

  const out = new Uint8Array(width * 2);
  out.set(rFixed, 0);
  out.set(sFixed, width);
  return out;
}
