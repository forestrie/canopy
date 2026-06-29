/** Decode permanent SCRAPI entryId (32 hex chars = idtimestamp_be8 || mmrIndex_be8). */

export interface DecodedEntryId {
  idtimestamp: bigint;
  mmrIndex: bigint;
}

function readU64BE(buf: Uint8Array, offset: number): bigint {
  let v = 0n;
  for (let i = 0; i < 8; i++) {
    v = (v << 8n) | BigInt(buf[offset + i]!);
  }
  return v;
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

export function decodeEntryIdHex(entryIdHex: string): DecodedEntryId {
  if (!/^[0-9a-f]{32}$/i.test(entryIdHex)) {
    throw new Error(`entryId must be 32 lowercase hex chars: ${entryIdHex}`);
  }
  const lower = entryIdHex.toLowerCase();
  const bytes = hexToBytes(lower);
  return {
    idtimestamp: readU64BE(bytes, 0),
    mmrIndex: readU64BE(bytes, 8),
  };
}

/** First half of entryId (permanent URL): idtimestamp big-endian 8 bytes for header -65537. */
export function entryIdHexToIdtimestampBe8(entryIdHex: string): Uint8Array {
  const { idtimestamp } = decodeEntryIdHex(entryIdHex);
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, idtimestamp, false);
  return out;
}
