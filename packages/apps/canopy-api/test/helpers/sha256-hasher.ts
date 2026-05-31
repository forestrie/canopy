import type { Hasher } from "@canopy/merklelog";

/** SHA-256 hasher matching grant receipt-verify (Workers crypto.subtle). */
export class Sha256Hasher implements Hasher {
  private chunks: Uint8Array[] = [];

  reset(): void {
    this.chunks = [];
  }

  update(data: Uint8Array): void {
    this.chunks.push(data);
  }

  async digest(): Promise<Uint8Array> {
    const totalLength = this.chunks.reduce((s, c) => s + c.length, 0);
    const combined = new Uint8Array(totalLength);
    let offset = 0;
    for (const c of this.chunks) {
      combined.set(c, offset);
      offset += c.length;
    }
    const h = await crypto.subtle.digest("SHA-256", combined);
    return new Uint8Array(h);
  }
}
