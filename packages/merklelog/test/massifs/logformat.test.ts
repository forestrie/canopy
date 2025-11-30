import { describe, it, expect } from "vitest";
import {
  peakStackEnd,
  massifLogEntries,
  LogFormat,
} from "../../src/massifs/logformat.js";

describe("logformat", () => {
  describe("peakStackEnd", () => {
    it("should calculate peak stack end for massif height 0", () => {
      const result = peakStackEnd(0);
      // FixedHeaderEnd (256) + IndexHeaderBytes (32) + TrieDataSize (64 * 1) + PeakStackSize (64 * 32)
      const expected =
        BigInt(LogFormat.StartHeaderSize) +
        BigInt(LogFormat.IndexHeaderBytes) +
        BigInt(LogFormat.TrieEntryBytes * 1) +
        BigInt(LogFormat.MaxMmrHeight * LogFormat.ValueBytes);
      expect(result).toBe(expected);
    });

    it("should calculate peak stack end for massif height 1", () => {
      const result = peakStackEnd(1);
      // FixedHeaderEnd (256) + IndexHeaderBytes (32) + TrieDataSize (64 * 2) + PeakStackSize (64 * 32)
      const expected =
        BigInt(LogFormat.StartHeaderSize) +
        BigInt(LogFormat.IndexHeaderBytes) +
        BigInt(LogFormat.TrieEntryBytes * 2) +
        BigInt(LogFormat.MaxMmrHeight * LogFormat.ValueBytes);
      expect(result).toBe(expected);
    });

    it("should calculate peak stack end for massif height 3", () => {
      const result = peakStackEnd(3);
      // FixedHeaderEnd (256) + IndexHeaderBytes (32) + TrieDataSize (64 * 8) + PeakStackSize (64 * 32)
      const expected =
        BigInt(LogFormat.StartHeaderSize) +
        BigInt(LogFormat.IndexHeaderBytes) +
        BigInt(LogFormat.TrieEntryBytes * 8) +
        BigInt(LogFormat.MaxMmrHeight * LogFormat.ValueBytes);
      expect(result).toBe(expected);
    });

    it("should increase with massif height", () => {
      const result0 = peakStackEnd(0);
      const result1 = peakStackEnd(1);
      const result2 = peakStackEnd(2);

      expect(result1).toBeGreaterThan(result0);
      expect(result2).toBeGreaterThan(result1);
    });
  });

  describe("massifLogEntries", () => {
    it("should calculate log entries for a valid massif", () => {
      const massifHeight = 3;
      const stackEnd = peakStackEnd(massifHeight);
      const dataLen = Number(stackEnd) + 100 * LogFormat.ValueBytes; // 100 entries after stack

      const entries = massifLogEntries(dataLen, massifHeight);
      expect(entries).toBe(100n);
    });

    it("should throw error if data length is too short", () => {
      const massifHeight = 3;
      const stackEnd = peakStackEnd(massifHeight);
      const dataLen = Number(stackEnd) - 1; // One byte too short

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
      const dataLen = Number(stackEnd) + 50 * LogFormat.ValueBytes + 10; // 50 entries + 10 extra bytes

      const entries = massifLogEntries(dataLen, massifHeight);
      // Should round down to 50 entries (extra 10 bytes don't form a complete entry)
      expect(entries).toBe(50n);
    });
  });
});
