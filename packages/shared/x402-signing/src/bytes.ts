export function hexToBytes(hex: string): Uint8Array {
  let clean = hex.toLowerCase();
  if (clean.startsWith("0x")) {
    clean = clean.slice(2);
  }
  if (clean.length === 0 || clean.length % 2 !== 0) {
    throw new Error("hex string must have even length");
  }
  const bytes = new Uint8Array(clean.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    const byte = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
    if (Number.isNaN(byte)) {
      throw new Error("invalid hex string");
    }
    bytes[i] = byte;
  }
  return bytes;
}

export function bytesToHex(bytes: Uint8Array): `0x${string}` {
  let hex = "";
  for (const b of bytes) {
    hex += b.toString(16).padStart(2, "0");
  }
  return `0x${hex}`;
}
