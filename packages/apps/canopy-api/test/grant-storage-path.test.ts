/**
 * Grant storage path unit tests (Plan 0001 Step 2 verification).
 */

import { describe, expect, it } from "vitest";
import { KIND_ATTESTOR, KIND_PUBLISH_CHECKPOINT } from "../src/grant/kinds.js";
import { grantStoragePath } from "../src/grant/storage-path.js";

const KIND_ATTESTOR_BYTES = new Uint8Array([KIND_ATTESTOR]);
const KIND_PUBLISH_BYTES = new Uint8Array([KIND_PUBLISH_CHECKPOINT]);

describe("grantStoragePath", () => {
  it("same encoded bytes + kind produce same path", async () => {
    const bytes = new Uint8Array([1, 2, 3, 4, 5]);
    const a = await grantStoragePath(bytes, KIND_ATTESTOR_BYTES);
    const b = await grantStoragePath(bytes, KIND_ATTESTOR_BYTES);
    expect(a).toBe(b);
  });

  it("path is non-empty and matches format <kind>/<hash>.cbor", async () => {
    const bytes = new Uint8Array([0x61, 0x62, 0x63]);
    const path = await grantStoragePath(bytes, KIND_ATTESTOR_BYTES);
    expect(path.length).toBeGreaterThan(0);
    expect(path).toMatch(/^attestor\/[0-9a-f]{64}\.cbor$/);
  });

  it("different bytes produce different path", async () => {
    const path1 = await grantStoragePath(new Uint8Array([1]), KIND_ATTESTOR_BYTES);
    const path2 = await grantStoragePath(new Uint8Array([2]), KIND_ATTESTOR_BYTES);
    expect(path1).not.toBe(path2);
  });

  it("different kind produces different path", async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const a = await grantStoragePath(bytes, KIND_ATTESTOR_BYTES);
    const b = await grantStoragePath(bytes, KIND_PUBLISH_BYTES);
    expect(a).not.toBe(b);
    expect(a.startsWith("attestor/")).toBe(true);
    expect(b.startsWith("publish-checkpoint/")).toBe(true);
  });

  it("path uses only allowed characters (alphanumeric, hyphen, slash, dot)", async () => {
    const bytes = new Uint8Array(10);
    const path = await grantStoragePath(bytes, KIND_ATTESTOR_BYTES);
    expect(path).toMatch(/^[a-zA-Z0-9\-]+\/[0-9a-f]+\.cbor$/);
  });

  it("unknown kind byte produces kind-N path segment", async () => {
    const bytes = new Uint8Array([1]);
    const path = await grantStoragePath(bytes, new Uint8Array([99]));
    expect(path).toMatch(/^kind-99\/[0-9a-f]{64}\.cbor$/);
  });
});
