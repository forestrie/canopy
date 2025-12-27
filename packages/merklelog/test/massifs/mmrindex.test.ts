import { describe, it, expect } from "vitest";
import { computeLastMMRIndex } from "../../src/massifs/mmrindex.js";
import { peakStackEnd } from "../../src/massifs/peakstackend.js";
import { massifFirstLeaf } from "../../src/mmr/index.js";
import { LogFormat } from "../../src/massifs/logformat.js";

describe("mmrindex", () => {
  describe("computeLastMMRIndex", () => {
    it("should return firstIndex - 1 for empty massif (no log entries)", () => {
      const massifHeight = 3;
      const massifIndex = 0;
      // Blob size exactly at peakStackEnd means 0 log entries
      // Need to use massifHeight - 1 for peakStackEnd (it expects 0-based internally)
      const blobSize = Number(peakStackEnd(massifHeight));

      const result = computeLastMMRIndex(massifHeight, massifIndex, blobSize);
      const firstIndex = massifFirstLeaf(massifHeight, massifIndex);

      // With 0 entries: lastIndex = firstIndex + 0 - 1 = firstIndex - 1
      expect(result).toBe(firstIndex - 1n);
    });

    it("should compute correctly for massif with 1 entry", () => {
      const massifHeight = 3;
      const massifIndex = 0;
      const blobSize =
        Number(peakStackEnd(massifHeight)) + LogFormat.ValueBytes;

      const result = computeLastMMRIndex(massifHeight, massifIndex, blobSize);
      const firstIndex = massifFirstLeaf(massifHeight, massifIndex);

      // With 1 entry: lastIndex = firstIndex + 1 - 1 = firstIndex
      expect(result).toBe(firstIndex);
    });

    it("should compute correctly for massif with multiple entries", () => {
      const massifHeight = 3;
      const massifIndex = 0;
      const numEntries = 7;
      const blobSize =
        Number(peakStackEnd(massifHeight)) + numEntries * LogFormat.ValueBytes;

      const result = computeLastMMRIndex(massifHeight, massifIndex, blobSize);
      const firstIndex = massifFirstLeaf(massifHeight, massifIndex);

      expect(result).toBe(firstIndex + BigInt(numEntries) - 1n);
    });

    it("should compute correctly for non-zero massif index", () => {
      const massifHeight = 3;
      const massifIndex = 5;
      const numEntries = 10;
      const blobSize =
        Number(peakStackEnd(massifHeight)) + numEntries * LogFormat.ValueBytes;

      const result = computeLastMMRIndex(massifHeight, massifIndex, blobSize);
      const firstIndex = massifFirstLeaf(massifHeight, massifIndex);

      expect(result).toBe(firstIndex + BigInt(numEntries) - 1n);
    });

    it("should compute correctly for different massif heights", () => {
      const massifIndex = 0;
      const numEntries = 15;

      for (const massifHeight of [1, 3, 5, 14]) {
        const blobSize =
          Number(peakStackEnd(massifHeight)) +
          numEntries * LogFormat.ValueBytes;
        const result = computeLastMMRIndex(massifHeight, massifIndex, blobSize);
        const firstIndex = massifFirstLeaf(massifHeight, massifIndex);

        expect(result).toBe(firstIndex + BigInt(numEntries) - 1n);
      }
    });

    it("should throw if blob size is too small", () => {
      const massifHeight = 3;
      const massifIndex = 0;
      const blobSize = Number(peakStackEnd(massifHeight)) - 1; // Too small

      expect(() =>
        computeLastMMRIndex(massifHeight, massifIndex, blobSize),
      ).toThrow();
    });
  });
});
