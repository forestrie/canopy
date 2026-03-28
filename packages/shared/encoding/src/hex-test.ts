/** Test-only hex helpers (not exported from package index). */

export function hexToBytes(hex: string): Uint8Array {
  const s = hex.replace(/\s+/g, "");
  if (s.length % 2 !== 0) {
    throw new Error("odd hex length");
  }
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(s.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

export function bytesToHex(b: Uint8Array): string {
  let s = "";
  for (let i = 0; i < b.length; i++) {
    s += b[i]!.toString(16).padStart(2, "0");
  }
  return s;
}
