import { describe, it, expect } from "vitest";
import { createSyncHasher } from "../../src/mmr/algorithms-sync.js";
import { calculateRoot, verifyInclusion } from "../../src/mmr/algorithms.js";
import type { Proof } from "../../src/mmr/types.js";

describe("algorithms-sync", () => {
  describe("createSyncHasher", () => {
    it("returns a Hasher that resolves digest immediately", async () => {
      const hasher = await createSyncHasher();
      hasher.update(new Uint8Array([1, 2, 3]));
      const digest = await hasher.digest();
      expect(digest).toBeInstanceOf(Uint8Array);
      expect(digest.length).toBe(32);
    });

    it("works with calculateRoot and verifyInclusion", async () => {
      const hasher = await createSyncHasher();
      const leafHash = new Uint8Array(32);
      leafHash[0] = 0x01;
      const proof: Proof = { path: [], leafIndex: 0n };

      const root = await calculateRoot(hasher, leafHash, proof, 0n);
      expect(root.length).toBe(32);

      const isValid = await verifyInclusion(hasher, leafHash, proof, root);
      expect(isValid).toBe(true);
    });
  });
});
