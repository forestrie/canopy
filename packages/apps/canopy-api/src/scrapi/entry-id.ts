const U64_MAX = (1n << 64n) - 1n;

function parseUint64(input: string | bigint, name: string): bigint {
  let v: bigint;
  try {
    v = typeof input === "bigint" ? input : BigInt(input);
  } catch {
    throw new Error(`${name} must be a uint64 (decimal string or bigint)`);
  }
  if (v < 0n || v > U64_MAX) {
    throw new Error(`${name} must be in range 0..2^64-1`);
  }
  return v;
}

function writeU64BE(out: Uint8Array, offset: number, value: bigint) {
  let v = value;
  for (let i = 7; i >= 0; i--) {
    out[offset + i] = Number(v & 0xffn);
    v >>= 8n;
  }
}

function readU64BE(buf: Uint8Array, offset: number): bigint {
  let v = 0n;
  for (let i = 0; i < 8; i++) {
    v = (v << 8n) | BigInt(buf[offset + i]);
  }
  return v;
}

function bytesToHex(bytes: Uint8Array): string {
  // Lowercase hex.
  let out = "";
  for (const b of bytes) {
    out += b.toString(16).padStart(2, "0");
  }
  return out;
}

function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) {
    throw new Error("hex string must have even length");
  }
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    const byte = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    if (!Number.isFinite(byte) || Number.isNaN(byte)) {
      throw new Error("invalid hex string");
    }
    out[i] = byte;
  }
  return out;
}

export interface EntryId {
  idtimestamp: bigint;
  mmrIndex: bigint;
}

export function isEntryIdHex(entryId: string): boolean {
  return /^[0-9a-f]{32}$/i.test(entryId);
}

export function encodeEntryId(input: {
  idtimestamp: string | bigint;
  mmrIndex: string | bigint;
}): string {
  const idtimestamp = parseUint64(input.idtimestamp, "idtimestamp");
  const mmrIndex = parseUint64(input.mmrIndex, "mmrIndex");

  const bytes = new Uint8Array(16);
  writeU64BE(bytes, 0, idtimestamp);
  writeU64BE(bytes, 8, mmrIndex);
  return bytesToHex(bytes);
}

export function decodeEntryId(entryIdHex: string): EntryId {
  if (!isEntryIdHex(entryIdHex)) {
    throw new Error("entryId must be exactly 16 bytes (32 hex characters)");
  }

  const bytes = hexToBytes(entryIdHex);
  if (bytes.length !== 16) {
    // Defensive: regex already enforced this.
    throw new Error("entryId must be 16 bytes");
  }

  return {
    idtimestamp: readU64BE(bytes, 0),
    mmrIndex: readU64BE(bytes, 8),
  };
}
