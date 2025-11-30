import { describe, it, expect } from "vitest";
import { bagPeaks, calculateRoot, verifyInclusion, Hasher } from "../../src/mmr/algorithms.js";
import type { Proof } from "../../src/mmr/types.js";

// Simple SHA-256 hasher implementation for testing
class TestHasher implements Hasher {
  private data: Uint8Array[] = [];

  reset(): void {
    this.data = [];
  }

  update(data: Uint8Array): void {
    this.data.push(data);
  }

  digest(): Uint8Array {
    // Simple hash simulation for testing (not cryptographically secure)
    // XOR all bytes together to create a deterministic "hash" that's different from inputs
    const result = new Uint8Array(32);
    let hash = 0;
    for (const arr of this.data) {
      for (let i = 0; i < arr.length; i++) {
        hash ^= arr[i];
        result[i % 32] ^= arr[i];
      }
    }
    // Fill remaining bytes with hash value to ensure different inputs produce different outputs
    for (let i = 0; i < 32; i++) {
      result[i] = (result[i] + hash + i) & 0xff;
    }
    return result;
  }
}

describe("MMR Algorithms", () => {
  describe("bagPeaks", () => {
    it("should return single peak as-is", () => {
      const hasher = new TestHasher();
      const peak = new Uint8Array(32);
      peak[0] = 0x42;
      const result = bagPeaks(hasher, [peak]);
      expect(result).toEqual(peak);
    });

    it("should bag two peaks", () => {
      const hasher = new TestHasher();
      const peak1 = new Uint8Array(32);
      peak1[0] = 0x01;
      const peak2 = new Uint8Array(32);
      peak2[0] = 0x02;

      const result = bagPeaks(hasher, [peak1, peak2]);
      expect(result.length).toBe(32);
      expect(result).not.toEqual(peak1);
      expect(result).not.toEqual(peak2);
    });

    it("should throw on empty peaks", () => {
      const hasher = new TestHasher();
      expect(() => bagPeaks(hasher, [])).toThrow();
    });
  });

  describe("calculateRoot", () => {
    it("should calculate root from leaf and empty proof", () => {
      const hasher = new TestHasher();
      const leafHash = new Uint8Array(32);
      leafHash[0] = 0x01;

      const proof: Proof = {
        path: [],
        leafIndex: 0n,
      };

      const root = calculateRoot(hasher, leafHash, proof, 0n);
      expect(root.length).toBe(32);
    });

    it("should calculate root from leaf and proof path", () => {
      const hasher = new TestHasher();
      const leafHash = new Uint8Array(32);
      leafHash[0] = 0x01;

      const siblingHash = new Uint8Array(32);
      siblingHash[0] = 0x02;

      const proof: Proof = {
        path: [siblingHash],
        leafIndex: 0n,
      };

      const root = calculateRoot(hasher, leafHash, proof, 0n);
      expect(root.length).toBe(32);
    });
  });

  describe("verifyInclusion", () => {
    it("should verify simple inclusion proof", () => {
      const hasher = new TestHasher();
      const leafHash = new Uint8Array(32);
      leafHash[0] = 0x01;

      const proof: Proof = {
        path: [],
        leafIndex: 0n,
      };

      // Calculate expected root
      const expectedRoot = calculateRoot(hasher, leafHash, proof, 0n);

      // Verify
      const isValid = verifyInclusion(hasher, leafHash, proof, expectedRoot);
      expect(isValid).toBe(true);
    });

    it("should reject invalid proof", () => {
      const hasher = new TestHasher();
      const leafHash = new Uint8Array(32);
      leafHash[0] = 0x01;

      const proof: Proof = {
        path: [],
        leafIndex: 0n,
      };

      const wrongRoot = new Uint8Array(32);
      wrongRoot[0] = 0xFF;

      const isValid = verifyInclusion(hasher, leafHash, proof, wrongRoot);
      expect(isValid).toBe(false);
    });

    it("should throw if proof has no index", () => {
      const hasher = new TestHasher();
      const leafHash = new Uint8Array(32);
      const proof: Proof = {
        path: [],
      };

      const root = new Uint8Array(32);
      expect(() => verifyInclusion(hasher, leafHash, proof, root)).toThrow();
    });
  });
});

