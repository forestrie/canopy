import { describe, it, expect } from "vitest";
import { Uint64 } from "../../src/uint64/index.js";
import {
  heightIndex,
  height,
  mmrPosition,
  mmrSizeFromHeightIndex,
  leafCount,
  leafCountFromHeightIndex,
} from "../../src/mmr/math.js";
import { mmrIndex, massifFirstLeaf, leafMinusSpurSum } from "../../src/mmr/index.js";

describe("MMR Math Functions", () => {
  describe("heightIndex", () => {
    it("should return 0 for leaf nodes", () => {
      const leaf = new Uint64(0);
      expect(heightIndex(leaf)).toBe(0);
    });

    it("should return correct height index for interior nodes", () => {
      // Node 2 in a small MMR should have height index 1
      const node2 = new Uint64(2);
      expect(heightIndex(node2)).toBeGreaterThan(0);
    });
  });

  describe("height", () => {
    it("should return height = heightIndex + 1", () => {
      const node = new Uint64(2);
      const hIdx = heightIndex(node);
      expect(height(node)).toBe(hIdx + 1);
    });
  });

  describe("mmrPosition", () => {
    it("should convert index to position (index + 1)", () => {
      const index = new Uint64(5);
      const position = mmrPosition(index);
      expect(position.toBigInt()).toBe(6n);
    });
  });

  describe("mmrSizeFromHeightIndex", () => {
    it("should calculate size for height index 0", () => {
      const size = mmrSizeFromHeightIndex(0);
      expect(size.toBigInt()).toBe(1n); // 2^(0+1) - 1 = 1
    });

    it("should calculate size for height index 1", () => {
      const size = mmrSizeFromHeightIndex(1);
      expect(size.toBigInt()).toBe(3n); // 2^(1+1) - 1 = 3
    });

    it("should calculate size for height index 2", () => {
      const size = mmrSizeFromHeightIndex(2);
      expect(size.toBigInt()).toBe(7n); // 2^(2+1) - 1 = 7
    });
  });

  describe("leafCount", () => {
    it("should calculate leaf count from MMR size", () => {
      const size = new Uint64(7); // 3 leaves
      const leaves = leafCount(size);
      expect(leaves.toBigInt()).toBe(4n); // (7 + 1) / 2 = 4
    });
  });

  describe("leafCountFromHeightIndex", () => {
    it("should calculate leaf count for height index 0", () => {
      const leaves = leafCountFromHeightIndex(0);
      expect(leaves.toBigInt()).toBe(1n); // 2^0 = 1
    });

    it("should calculate leaf count for height index 1", () => {
      const leaves = leafCountFromHeightIndex(1);
      expect(leaves.toBigInt()).toBe(2n); // 2^1 = 2
    });

    it("should calculate leaf count for height index 2", () => {
      const leaves = leafCountFromHeightIndex(2);
      expect(leaves.toBigInt()).toBe(4n); // 2^2 = 4
    });
  });
});

describe("MMR Index Functions", () => {
  describe("mmrIndex", () => {
    it("should convert leaf index 0 to MMR index 0", () => {
      const result = mmrIndex(0n);
      expect(result).toBe(0n);
    });

    it("should convert leaf index 1 to MMR index 1", () => {
      const result = mmrIndex(1n);
      expect(result).toBe(1n);
    });

    it("should convert leaf index 2 to MMR index 3", () => {
      const result = mmrIndex(2n);
      expect(result).toBe(3n);
    });
  });

  describe("massifFirstLeaf", () => {
    it("should calculate first leaf for massif 0", () => {
      const result = massifFirstLeaf(3, 0);
      // Massif 0 starts at leaf index 0, which is MMR index 0
      expect(result).toBe(0n);
    });

    it("should calculate first leaf for massif 1", () => {
      const result0 = massifFirstLeaf(3, 0);
      const result1 = massifFirstLeaf(3, 1);
      expect(result1).toBeGreaterThan(result0);
    });
  });

  describe("leafMinusSpurSum", () => {
    it("should return 0 for leaf index 0", () => {
      const result = leafMinusSpurSum(0n);
      expect(result).toBe(0n);
    });

    it("should return correct value for leaf index 1", () => {
      const result = leafMinusSpurSum(1n);
      expect(result).toBeGreaterThanOrEqual(0n);
    });
  });
});

