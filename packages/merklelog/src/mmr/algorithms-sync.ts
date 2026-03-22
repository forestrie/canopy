/**
 * Convenience factory for a sync-backed Hasher (Node.js).
 *
 * createSyncHasher() returns a Hasher that uses node:crypto (SHA-256).
 * digest() returns Promise.resolve(sync digest), so the hasher is suitable
 * for callers who know they are in Node and want a sync-backed implementation.
 */

import type { Hasher } from "./types.js";

function concatChunks(chunks: Uint8Array[]): Uint8Array {
  const totalLength = chunks.reduce((s, c) => s + c.length, 0);
  const out = new Uint8Array(totalLength);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

/**
 * Creates a Hasher that uses Node's crypto.createHash('sha256').
 * digest() returns Promise.resolve(sync digest), so it is safe to use with
 * when you need a sync-backed hasher (e.g. in Node).
 *
 * Only available in Node.js; throws if node:crypto is not available.
 */
export async function createSyncHasher(): Promise<Hasher> {
  const { createHash } = await import("node:crypto");
  const chunks: Uint8Array[] = [];
  return {
    reset(): void {
      chunks.length = 0;
    },
    update(data: Uint8Array): void {
      chunks.push(data);
    },
    digest(): Promise<Uint8Array> {
      const combined = concatChunks(chunks);
      const buf = Buffer.from(combined);
      const out = createHash("sha256").update(buf).digest();
      return Promise.resolve(new Uint8Array(out));
    },
  };
}
