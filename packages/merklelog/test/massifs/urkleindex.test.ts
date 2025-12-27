import { describe, it, expect } from "vitest";
import {
  urkleLeafTableStartFieldIndex,
  urkleLeafTableStartByteOffset,
  createLeafEnumerator,
  leafComponentByteOffset,
  leafComponentSize,
} from "../../src/massifs/urkleindex.js";
import {
  Urkle,
  Bloom,
  leafCountForMassifHeight,
  bloomMBits,
  bloomBitsetBytes,
} from "../../src/massifs/indexformat.js";
import { LogFormat } from "../../src/massifs/logformat.js";

describe("urkleindex", () => {
  describe("leafCountForMassifHeight", () => {
    it("should return 0 for height 0", () => {
      expect(leafCountForMassifHeight(0)).toBe(0n);
    });

    it("should return 1 for height 1", () => {
      expect(leafCountForMassifHeight(1)).toBe(1n);
    });

    it("should return 4 for height 3", () => {
      expect(leafCountForMassifHeight(3)).toBe(4n);
    });

    it("should return 8192 for height 14", () => {
      expect(leafCountForMassifHeight(14)).toBe(8192n);
    });
  });

  describe("urkleLeafTableStartByteOffset", () => {
    it("should compute correct byte offset for massif height 1", () => {
      const offset = urkleLeafTableStartByteOffset(1);

      // Expected: StartHeader(256) + IndexHeader(32) + BloomBitsets + Frontier(544)
      const leafCount = leafCountForMassifHeight(1);
      const mBits = bloomMBits(leafCount);
      const bloomBitsetsOnly = Number(
        BigInt(Bloom.Filters) * bloomBitsetBytes(mBits),
      );

      const expected =
        LogFormat.StartHeaderSize +
        LogFormat.IndexHeaderBytes +
        bloomBitsetsOnly +
        Urkle.FrontierStateV1Bytes;

      expect(offset).toBe(expected);
    });

    it("should compute correct byte offset for massif height 14", () => {
      const offset = urkleLeafTableStartByteOffset(14);

      const leafCount = leafCountForMassifHeight(14);
      const mBits = bloomMBits(leafCount);
      const bloomBitsetsOnly = Number(
        BigInt(Bloom.Filters) * bloomBitsetBytes(mBits),
      );

      const expected =
        LogFormat.StartHeaderSize +
        LogFormat.IndexHeaderBytes +
        bloomBitsetsOnly +
        Urkle.FrontierStateV1Bytes;

      expect(offset).toBe(expected);
    });

    it("should increase with massif height", () => {
      const offset1 = urkleLeafTableStartByteOffset(1);
      const offset2 = urkleLeafTableStartByteOffset(2);
      const offset3 = urkleLeafTableStartByteOffset(3);

      expect(offset2).toBeGreaterThan(offset1);
      expect(offset3).toBeGreaterThan(offset2);
    });
  });

  describe("urkleLeafTableStartFieldIndex", () => {
    it("should return byte offset / 32 for massif height 1", () => {
      const fieldIndex = urkleLeafTableStartFieldIndex(1);
      const byteOffset = urkleLeafTableStartByteOffset(1);

      expect(fieldIndex).toBe(Math.floor(byteOffset / LogFormat.ValueBytes));
    });

    it("should return byte offset / 32 for massif height 14", () => {
      const fieldIndex = urkleLeafTableStartFieldIndex(14);
      const byteOffset = urkleLeafTableStartByteOffset(14);

      expect(fieldIndex).toBe(Math.floor(byteOffset / LogFormat.ValueBytes));
    });
  });

  describe("leafComponentByteOffset", () => {
    it("should compute correct offset for idtimestamp", () => {
      const massifHeight = 3;
      const leafOrdinal = 0;
      const offset = leafComponentByteOffset(
        massifHeight,
        leafOrdinal,
        "idtimestamp",
      );

      const tableStart = urkleLeafTableStartByteOffset(massifHeight);
      expect(offset).toBe(tableStart); // idtimestamp is at offset 0 in leaf record
    });

    it("should compute correct offset for valueBytes", () => {
      const massifHeight = 3;
      const leafOrdinal = 0;
      const offset = leafComponentByteOffset(
        massifHeight,
        leafOrdinal,
        "valueBytes",
      );

      const tableStart = urkleLeafTableStartByteOffset(massifHeight);
      expect(offset).toBe(tableStart + Urkle.LeafValueOffset); // 8
    });

    it("should compute correct offset for extra1", () => {
      const massifHeight = 3;
      const leafOrdinal = 0;
      const offset = leafComponentByteOffset(
        massifHeight,
        leafOrdinal,
        "extra1",
      );

      const tableStart = urkleLeafTableStartByteOffset(massifHeight);
      expect(offset).toBe(tableStart + Urkle.LeafExtra1Offset); // 40
    });

    it("should compute correct offset for second leaf", () => {
      const massifHeight = 3;
      const leafOrdinal = 1;
      const offset = leafComponentByteOffset(
        massifHeight,
        leafOrdinal,
        "idtimestamp",
      );

      const tableStart = urkleLeafTableStartByteOffset(massifHeight);
      expect(offset).toBe(tableStart + Urkle.LeafRecordBytes); // 128
    });
  });

  describe("leafComponentSize", () => {
    it("should return correct size for idtimestamp", () => {
      expect(leafComponentSize("idtimestamp")).toBe(8);
    });

    it("should return correct size for valueBytes", () => {
      expect(leafComponentSize("valueBytes")).toBe(32);
    });

    it("should return correct size for extra1", () => {
      expect(leafComponentSize("extra1")).toBe(24);
    });

    it("should return correct size for extra2", () => {
      expect(leafComponentSize("extra2")).toBe(32);
    });

    it("should return correct size for extra3", () => {
      expect(leafComponentSize("extra3")).toBe(32);
    });
  });

  describe("createLeafEnumerator", () => {
    function createTestBuffer(
      massifHeight: number,
      leafCount: number,
    ): Uint8Array {
      const tableStart = urkleLeafTableStartByteOffset(massifHeight);
      const bufferSize = tableStart + leafCount * Urkle.LeafRecordBytes;
      const buffer = new Uint8Array(bufferSize);
      const view = new DataView(buffer.buffer);

      // Write test data for each leaf
      for (let i = 0; i < leafCount; i++) {
        const recordOffset = tableStart + i * Urkle.LeafRecordBytes;

        // Write idtimestamp (big-endian uint64)
        view.setBigUint64(recordOffset, BigInt(0x1000 + i), false);

        // Write valueBytes (32 bytes starting with leaf index)
        buffer[recordOffset + Urkle.LeafValueOffset] = i;

        // Write extra1 (24 bytes starting with 0xE1)
        buffer[recordOffset + Urkle.LeafExtra1Offset] = 0xe1;

        // Write extra2 (32 bytes starting with 0xE2)
        buffer[recordOffset + Urkle.LeafExtra2Offset] = 0xe2;

        // Write extra3 (32 bytes starting with 0xE3)
        buffer[recordOffset + Urkle.LeafExtra3Offset] = 0xe3;
      }

      return buffer;
    }

    it("should enumerate idtimestamp only", () => {
      const massifHeight = 3;
      const leafCount = 4;
      const buffer = createTestBuffer(massifHeight, leafCount);

      const enumerate = createLeafEnumerator(buffer, massifHeight, leafCount, {
        idtimestamp: true,
      });

      const entries = [...enumerate()];

      expect(entries.length).toBe(leafCount);
      for (let i = 0; i < leafCount; i++) {
        expect(entries[i].ordinal).toBe(i);
        expect(entries[i].idtimestamp).toBe(BigInt(0x1000 + i));
        expect(entries[i].valueBytes).toBeUndefined();
        expect(entries[i].extra1).toBeUndefined();
      }
    });

    it("should enumerate valueBytes only", () => {
      const massifHeight = 3;
      const leafCount = 4;
      const buffer = createTestBuffer(massifHeight, leafCount);

      const enumerate = createLeafEnumerator(buffer, massifHeight, leafCount, {
        valueBytes: true,
      });

      const entries = [...enumerate()];

      expect(entries.length).toBe(leafCount);
      for (let i = 0; i < leafCount; i++) {
        expect(entries[i].ordinal).toBe(i);
        expect(entries[i].idtimestamp).toBeUndefined();
        expect(entries[i].valueBytes).toBeInstanceOf(Uint8Array);
        expect(entries[i].valueBytes!.length).toBe(32);
        expect(entries[i].valueBytes![0]).toBe(i);
      }
    });

    it("should enumerate all components", () => {
      const massifHeight = 3;
      const leafCount = 2;
      const buffer = createTestBuffer(massifHeight, leafCount);

      const enumerate = createLeafEnumerator(buffer, massifHeight, leafCount, {
        idtimestamp: true,
        valueBytes: true,
        extra1: true,
        extra2: true,
        extra3: true,
      });

      const entries = [...enumerate()];

      expect(entries.length).toBe(leafCount);
      for (let i = 0; i < leafCount; i++) {
        expect(entries[i].ordinal).toBe(i);
        expect(entries[i].idtimestamp).toBe(BigInt(0x1000 + i));
        expect(entries[i].valueBytes![0]).toBe(i);
        expect(entries[i].extra1![0]).toBe(0xe1);
        expect(entries[i].extra2![0]).toBe(0xe2);
        expect(entries[i].extra3![0]).toBe(0xe3);
      }
    });

    it("should return views without copying", () => {
      const massifHeight = 3;
      const leafCount = 2;
      const buffer = createTestBuffer(massifHeight, leafCount);

      const enumerate = createLeafEnumerator(buffer, massifHeight, leafCount, {
        valueBytes: true,
      });

      const entries = [...enumerate()];

      // Modify original buffer
      const tableStart = urkleLeafTableStartByteOffset(massifHeight);
      buffer[tableStart + Urkle.LeafValueOffset] = 0xff;

      // View should reflect the change (proves it's not a copy)
      expect(entries[0].valueBytes![0]).toBe(0xff);
    });

    it("should handle empty leaf count", () => {
      const massifHeight = 3;
      const leafCount = 0;
      const buffer = new Uint8Array(
        urkleLeafTableStartByteOffset(massifHeight),
      );

      const enumerate = createLeafEnumerator(buffer, massifHeight, leafCount, {
        idtimestamp: true,
      });

      const entries = [...enumerate()];
      expect(entries.length).toBe(0);
    });

    it("should enumerate from start position", () => {
      const massifHeight = 3;
      const totalLeaves = 4;
      const buffer = createTestBuffer(massifHeight, totalLeaves);

      // Start from leaf 2, enumerate 2 leaves
      const startPos = 2;
      const count = 2;
      const enumerate = createLeafEnumerator(
        buffer,
        massifHeight,
        count,
        { idtimestamp: true },
        startPos,
      );

      const entries = [...enumerate()];

      expect(entries.length).toBe(count);
      // Ordinals should be 2 and 3 (the actual leaf ordinals)
      expect(entries[0].ordinal).toBe(2);
      expect(entries[0].idtimestamp).toBe(BigInt(0x1000 + 2));
      expect(entries[1].ordinal).toBe(3);
      expect(entries[1].idtimestamp).toBe(BigInt(0x1000 + 3));
    });

    it("should handle start position at beginning (default)", () => {
      const massifHeight = 3;
      const leafCount = 2;
      const buffer = createTestBuffer(massifHeight, leafCount);

      // Explicit start=0 should behave same as default
      const enumerate = createLeafEnumerator(
        buffer,
        massifHeight,
        leafCount,
        { idtimestamp: true },
        0,
      );

      const entries = [...enumerate()];

      expect(entries.length).toBe(leafCount);
      expect(entries[0].ordinal).toBe(0);
      expect(entries[1].ordinal).toBe(1);
    });
  });
});
