import { describe, it, expect } from "vitest";
import { peakStackEnd } from "../../src/massifs/peakstackend.js";
import { massifLogEntries } from "../../src/massifs/massiflogentries.js";
import { LogFormat } from "../../src/massifs/logformat.js";
import {
  indexDataBytesV2,
  leafCountForMassifHeight,
} from "../../src/massifs/indexformat.js";

describe("logformat v2", () => {
  describe("peakStackEnd", () => {
    it("should calculate peak stack end for massif height 1", () => {
      // massifHeight = 1 (one-based), leafCount = 2^(1-1) = 1
      const result = peakStackEnd(1);

      // Expected: StartHeader(256) + IndexHeader(32) + IndexData + PeakStack(2048)
      const leafCount = leafCountForMassifHeight(1);
      const indexData = indexDataBytesV2(leafCount);
      const expected =
        BigInt(LogFormat.StartHeaderSize) +
        BigInt(LogFormat.IndexHeaderBytes) +
        indexData +
        BigInt(LogFormat.MaxMmrHeight * LogFormat.ValueBytes);
      expect(result).toBe(expected);
    });

    it("should calculate peak stack end for massif height 3", () => {
      // massifHeight = 3 (one-based), leafCount = 2^(3-1) = 4
      const result = peakStackEnd(3);

      const leafCount = leafCountForMassifHeight(3);
      const indexData = indexDataBytesV2(leafCount);
      const expected =
        BigInt(LogFormat.StartHeaderSize) +
        BigInt(LogFormat.IndexHeaderBytes) +
        indexData +
        BigInt(LogFormat.MaxMmrHeight * LogFormat.ValueBytes);
      expect(result).toBe(expected);
    });

    it("should calculate peak stack end for massif height 14", () => {
      // massifHeight = 14 (one-based), leafCount = 2^13 = 8192
      const result = peakStackEnd(14);

      const leafCount = leafCountForMassifHeight(14);
      const indexData = indexDataBytesV2(leafCount);
      const expected =
        BigInt(LogFormat.StartHeaderSize) +
        BigInt(LogFormat.IndexHeaderBytes) +
        indexData +
        BigInt(LogFormat.MaxMmrHeight * LogFormat.ValueBytes);
      expect(result).toBe(expected);
    });

    it("should increase with massif height", () => {
      const result1 = peakStackEnd(1);
      const result2 = peakStackEnd(2);
      const result3 = peakStackEnd(3);

      expect(result2).toBeGreaterThan(result1);
      expect(result3).toBeGreaterThan(result2);
    });
  });

  describe("massifLogEntries", () => {
    it("should calculate log entries for a valid massif", () => {
      const massifHeight = 3;
      const stackEnd = peakStackEnd(massifHeight);
      const dataLen = Number(stackEnd) + 100 * LogFormat.ValueBytes;

      const entries = massifLogEntries(dataLen, massifHeight);
      expect(entries).toBe(100n);
    });

    it("should throw error if data length is too short", () => {
      const massifHeight = 3;
      const stackEnd = peakStackEnd(massifHeight);
      const dataLen = Number(stackEnd) - 1;

      expect(() => massifLogEntries(dataLen, massifHeight)).toThrow();
    });

    it("should return 0 entries if data is exactly at stack end", () => {
      const massifHeight = 3;
      const stackEnd = peakStackEnd(massifHeight);
      const dataLen = Number(stackEnd);

      const entries = massifLogEntries(dataLen, massifHeight);
      expect(entries).toBe(0n);
    });

    it("should handle partial entries correctly", () => {
      const massifHeight = 3;
      const stackEnd = peakStackEnd(massifHeight);
      const dataLen = Number(stackEnd) + 50 * LogFormat.ValueBytes + 10;

      const entries = massifLogEntries(dataLen, massifHeight);
      expect(entries).toBe(50n);
    });
  });
});
