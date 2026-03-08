/**
 * Encodes a grant request CBOR in the same format as perf/scripts/generate-grant-pool.mjs.
 * Used to verify the API's decode path (parseCborBody + parseGrantRequest) receives
 * the signer bytes correctly. Keys: 3=logId, 4=ownerLogId, 5=grantFlags, 8=grantData,
 * 9=signer, 10=kind; all values as bstr.
 */

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
  } else {
    header = new Uint8Array([0x59, (len >> 8) & 0xff, len & 0xff]);
  }
  return concat(header, bytes);
}

/**
 * Encode grant request as CBOR map(6) with keys 3,4,5,8,9,10 and bstr values.
 * Matches generate-grant-pool.mjs encodeGrantRequest byte-for-byte layout.
 */
export function encodeGrantRequestCbor(
  logId: Uint8Array,
  ownerLogId: Uint8Array,
  grantFlags: Uint8Array,
  grantData: Uint8Array,
  signer: Uint8Array,
  kind: Uint8Array,
): Uint8Array {
  const pairs: [number, Uint8Array][] = [
    [3, logId],
    [4, ownerLogId],
    [5, grantFlags],
    [8, grantData],
    [9, signer],
    [10, kind],
  ];
  const chunks: Uint8Array[] = [new Uint8Array([0xa6])]; // map(6)
  for (const [key, val] of pairs) {
    chunks.push(new Uint8Array([key]));
    chunks.push(encodeBstr(val));
  }
  return concat(...chunks);
}

/** Hex string (64 chars) -> 32 bytes, matching k6 signerToBytes for hex. */
export function hexToSignerBytes(hex: string): Uint8Array {
  const s = hex.trim();
  if (s.length !== 64 || !/^[0-9a-fA-F]+$/.test(s)) {
    throw new Error(`Invalid signer hex length or chars: ${s.length}`);
  }
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/** 32 bytes -> 64-char hex, matching generate-grant-pool pool payload. */
export function signerBytesToHex(bytes: Uint8Array): string {
  if (bytes.length !== 32)
    throw new Error(`Expected 32 bytes, got ${bytes.length}`);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
