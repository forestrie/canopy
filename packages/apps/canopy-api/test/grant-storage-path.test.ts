/**
 * Content-addressable grant paths (v0: `grant/{sha256}.cbor`).
 */

import { describe, expect, it } from "vitest";
import { grantStoragePath } from "../src/grant/storage-path.js";

describe("grantStoragePath", () => {
  it("is deterministic for same input", async () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const a = await grantStoragePath(bytes);
    const b = await grantStoragePath(bytes);
    expect(a).toBe(b);
  });

  it("uses grant/ prefix and .cbor suffix", async () => {
    const bytes = new Uint8Array([0xab, 0xcd]);
    const path = await grantStoragePath(bytes);
    expect(path.startsWith("grant/")).toBe(true);
    expect(path.endsWith(".cbor")).toBe(true);
  });

  it("differs when grant bytes differ", async () => {
    const path1 = await grantStoragePath(new Uint8Array([1]));
    const path2 = await grantStoragePath(new Uint8Array([2]));
    expect(path1).not.toBe(path2);
  });

  it("produces 64-char hex segment", async () => {
    const path = await grantStoragePath(new Uint8Array([0]));
    const m = path.match(/^grant\/([0-9a-f]{64})\.cbor$/);
    expect(m).not.toBeNull();
  });
});
