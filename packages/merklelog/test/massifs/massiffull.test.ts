import { describe, it, expect } from "vitest";
import { isMassifFull } from "../../src/massifs/massiffull.js";

describe("massiffull", () => {
  describe("isMassifFull", () => {
    describe("height 1 (1 leaf capacity)", () => {
      const massifHeight = 1;
      // Height 1: leaf capacity = 2^(1-1) = 1
      // Full massif has 1 leaf, which means 1 node (the leaf itself)

      it("should return false for 0 log entries", () => {
        expect(isMassifFull(massifHeight, 0n)).toBe(false);
      });

      it("should return true for 1 log entry (1 leaf)", () => {
        // logEntries = 1 -> actualLeaves = (1+1)/2 = 1
        expect(isMassifFull(massifHeight, 1n)).toBe(true);
      });
    });

    describe("height 2 (2 leaf capacity)", () => {
      const massifHeight = 2;
      // Height 2: leaf capacity = 2^(2-1) = 2
      // Full massif has 2 leaves, which means 3 nodes (2 leaves + 1 interior)

      it("should return false for 0 log entries", () => {
        expect(isMassifFull(massifHeight, 0n)).toBe(false);
      });

      it("should return false for 1 log entry (1 leaf)", () => {
        // logEntries = 1 -> actualLeaves = 1, need 2
        expect(isMassifFull(massifHeight, 1n)).toBe(false);
      });

      it("should return true for 3 log entries (2 leaves + 1 interior)", () => {
        // logEntries = 3 -> actualLeaves = (3+1)/2 = 2
        expect(isMassifFull(massifHeight, 3n)).toBe(true);
      });
    });

    describe("height 3 (4 leaf capacity)", () => {
      const massifHeight = 3;
      // Height 3: leaf capacity = 2^(3-1) = 4
      // Full massif has 4 leaves, which means 7 nodes (4 leaves + 3 interior)

      it("should return false for 0 log entries", () => {
        expect(isMassifFull(massifHeight, 0n)).toBe(false);
      });

      it("should return false for 3 log entries (2 leaves)", () => {
        // logEntries = 3 -> actualLeaves = 2, need 4
        expect(isMassifFull(massifHeight, 3n)).toBe(false);
      });

      it("should return true for 7 log entries (4 leaves)", () => {
        // logEntries = 7 -> actualLeaves = (7+1)/2 = 4
        expect(isMassifFull(massifHeight, 7n)).toBe(true);
      });

      it("should return true for more than 7 log entries", () => {
        // Even though impossible in practice, the function should return true
        expect(isMassifFull(massifHeight, 10n)).toBe(true);
      });
    });

    describe("height 14 (8192 leaf capacity)", () => {
      const massifHeight = 14;
      // Height 14: leaf capacity = 2^(14-1) = 8192
      // Full massif has 8192 leaves, which means 16383 nodes

      it("should return false for less than full", () => {
        // 16381 log entries -> actualLeaves = (16381+1)/2 = 8191
        expect(isMassifFull(massifHeight, 16381n)).toBe(false);
      });

      it("should return true for exactly full", () => {
        // 16383 log entries -> actualLeaves = (16383+1)/2 = 8192
        expect(isMassifFull(massifHeight, 16383n)).toBe(true);
      });
    });

    describe("leaf count formula", () => {
      it("should use actualLeaves = (logEntries + 1) / 2", () => {
        // For an MMR, the relationship is: nodes = 2*leaves - 1
        // So: leaves = (nodes + 1) / 2

        // Height 4: need 8 leaves, so 15 nodes
        expect(isMassifFull(4, 14n)).toBe(false); // 7 leaves
        expect(isMassifFull(4, 15n)).toBe(true); // 8 leaves

        // Height 5: need 16 leaves, so 31 nodes
        expect(isMassifFull(5, 30n)).toBe(false); // 15 leaves
        expect(isMassifFull(5, 31n)).toBe(true); // 16 leaves
      });
    });
  });
});
