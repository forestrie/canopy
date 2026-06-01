import { createHash } from "node:crypto";
import type { Hasher } from "../../src/mmr/types.js";

/**
 * Real SHA-256 hasher for merklelog tests.
 *
 * Concatenates updates then digests, matching the production grant
 * receipt-verify hasher and the reference `H(x)` convention. Replaces the
 * earlier toy XOR hasher so tests pin against real, externally-sourced
 * known-answer values (go-merklelog KAT39 / reference algorithms.py).
 */
export class Sha256Hasher implements Hasher {
  private chunks: Uint8Array[] = [];

  reset(): void {
    this.chunks = [];
  }

  update(data: Uint8Array): void {
    this.chunks.push(data);
  }

  digest(): Promise<Uint8Array> {
    const total = this.chunks.reduce((s, c) => s + c.length, 0);
    const combined = new Uint8Array(total);
    let off = 0;
    for (const c of this.chunks) {
      combined.set(c, off);
      off += c.length;
    }
    const out = createHash("sha256").update(combined).digest();
    return Promise.resolve(new Uint8Array(out));
  }
}

/** Hex string to Uint8Array. */
export function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) throw new Error("odd-length hex");
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/** Uint8Array to lowercase hex string. */
export function bytesToHex(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += b.toString(16).padStart(2, "0");
  return s;
}
