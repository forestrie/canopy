import { describe, it, expect } from "vitest";
import {
  Urkle,
  Bloom,
  IndexV2,
  leafCountForMassifHeight,
  leafTableBytes,
  nodeCountMax,
  nodeStoreBytes,
  bloomMBits,
  bloomBitsetBytes,
  bloomRegionBytes,
  indexDataBytesV2,
} from "../../src/massifs/indexformat.js";

describe("indexformat", () => {
  describe("Urkle namespace constants", () => {
    it("should have correct hash bytes", () => {
      expect(Urkle.HashBytes).toBe(32);
    });

    it("should have correct leaf ordinal bytes", () => {
      expect(Urkle.LeafOrdinalBytes).toBe(4);
    });

    it("should have correct leaf record bytes", () => {
      // 8 (key) + 32 (value) + 24 (extra1) + 32 (extra2) + 32 (extra3) = 128
      expect(Urkle.LeafRecordBytes).toBe(128);
    });

    it("should have correct node record bytes", () => {
      expect(Urkle.NodeRecordBytes).toBe(64);
    });

    it("should have correct frontier state bytes", () => {
      // 32 (header) + 64 * 8 (frames) = 544
      expect(Urkle.FrontierStateV1Bytes).toBe(544);
    });

    it("should have correct leaf field offsets", () => {
      expect(Urkle.LeafKeyBytes).toBe(8);
      expect(Urkle.LeafValueBytes).toBe(32);
      expect(Urkle.LeafExtra1Bytes).toBe(24);
      expect(Urkle.LeafExtraBytes).toBe(32);

      expect(Urkle.LeafValueOffset).toBe(8);
      expect(Urkle.LeafExtraOffset).toBe(40);
      expect(Urkle.LeafExtra1Offset).toBe(40);
      expect(Urkle.LeafExtra2Offset).toBe(64);
      expect(Urkle.LeafExtra3Offset).toBe(96);
    });

    it("should have leaf record size as multiple of 32", () => {
      expect(Urkle.LeafRecordBytes % 32).toBe(0);
    });
  });

  describe("Bloom namespace constants", () => {
    it("should have correct value bytes", () => {
      expect(Bloom.ValueBytes).toBe(32);
    });

    it("should have correct filter count", () => {
      expect(Bloom.Filters).toBe(4);
    });

    it("should have correct header bytes", () => {
      expect(Bloom.HeaderBytesV1).toBe(32);
    });

    it("should have correct magic string", () => {
      expect(Bloom.MagicV1).toBe("BLM1");
    });

    it("should have correct version", () => {
      expect(Bloom.VersionV1).toBe(1);
    });

    it("should have correct bit order constant", () => {
      expect(Bloom.BitOrderLSB0).toBe(0);
    });
  });

  describe("IndexV2 namespace constants", () => {
    it("should have correct bits per element", () => {
      expect(IndexV2.BloomBitsPerElement).toBe(10);
    });

    it("should have correct k value", () => {
      expect(IndexV2.BloomK).toBe(7);
    });
  });

  describe("leafCountForMassifHeight", () => {
    it("should return 0 for height 0", () => {
      expect(leafCountForMassifHeight(0)).toBe(0n);
    });

    it("should return 1 for height 1", () => {
      expect(leafCountForMassifHeight(1)).toBe(1n);
    });

    it("should return 2 for height 2", () => {
      expect(leafCountForMassifHeight(2)).toBe(2n);
    });

    it("should return 4 for height 3", () => {
      expect(leafCountForMassifHeight(3)).toBe(4n);
    });

    it("should return 8192 for height 14", () => {
      expect(leafCountForMassifHeight(14)).toBe(8192n);
    });

    it("should follow 2^(h-1) formula", () => {
      for (let h = 1; h <= 20; h++) {
        const expected = 1n << BigInt(h - 1);
        expect(leafCountForMassifHeight(h)).toBe(expected);
      }
    });
  });

  describe("leafTableBytes", () => {
    it("should return 0 for 0 leaves", () => {
      expect(leafTableBytes(0n)).toBe(0n);
    });

    it("should return LeafRecordBytes for 1 leaf", () => {
      expect(leafTableBytes(1n)).toBe(BigInt(Urkle.LeafRecordBytes));
    });

    it("should scale linearly with leaf count", () => {
      expect(leafTableBytes(10n)).toBe(10n * BigInt(Urkle.LeafRecordBytes));
      expect(leafTableBytes(100n)).toBe(100n * BigInt(Urkle.LeafRecordBytes));
    });
  });

  describe("nodeCountMax", () => {
    it("should return 0 for 0 leaves", () => {
      expect(nodeCountMax(0n)).toBe(0n);
    });

    it("should return 1 for 1 leaf", () => {
      expect(nodeCountMax(1n)).toBe(1n);
    });

    it("should return 3 for 2 leaves", () => {
      expect(nodeCountMax(2n)).toBe(3n);
    });

    it("should return 2N-1 for N leaves", () => {
      expect(nodeCountMax(4n)).toBe(7n);
      expect(nodeCountMax(8n)).toBe(15n);
      expect(nodeCountMax(100n)).toBe(199n);
    });
  });

  describe("nodeStoreBytes", () => {
    it("should return 0 for 0 leaves", () => {
      expect(nodeStoreBytes(0n)).toBe(0n);
    });

    it("should return NodeRecordBytes for 1 leaf", () => {
      expect(nodeStoreBytes(1n)).toBe(BigInt(Urkle.NodeRecordBytes));
    });

    it("should return (2N-1) * NodeRecordBytes", () => {
      expect(nodeStoreBytes(4n)).toBe(7n * BigInt(Urkle.NodeRecordBytes));
      expect(nodeStoreBytes(8n)).toBe(15n * BigInt(Urkle.NodeRecordBytes));
    });
  });

  describe("bloomMBits", () => {
    it("should return leafCount * bitsPerElement", () => {
      expect(bloomMBits(10n)).toBe(100n);
      expect(bloomMBits(100n)).toBe(1000n);
    });

    it("should use default bitsPerElement of 10", () => {
      expect(bloomMBits(1n)).toBe(10n);
      expect(bloomMBits(8192n)).toBe(81920n);
    });

    it("should allow custom bitsPerElement", () => {
      expect(bloomMBits(10n, 20n)).toBe(200n);
      expect(bloomMBits(100n, 5n)).toBe(500n);
    });

    it("should return 0 on overflow (> uint32 max)", () => {
      // uint32 max is 0xFFFFFFFF = 4294967295
      const hugeLeafCount = 0x100000000n; // 2^32
      expect(bloomMBits(hugeLeafCount)).toBe(0n);
    });

    it("should handle edge case near overflow", () => {
      // 429496729 * 10 = 4294967290, just under uint32 max
      expect(bloomMBits(429496729n)).toBe(4294967290n);
      // 429496730 * 10 = 4294967300, just over uint32 max
      expect(bloomMBits(429496730n)).toBe(0n);
    });
  });

  describe("bloomBitsetBytes", () => {
    it("should return ceil(mBits/8)", () => {
      expect(bloomBitsetBytes(0n)).toBe(0n);
      expect(bloomBitsetBytes(1n)).toBe(1n);
      expect(bloomBitsetBytes(7n)).toBe(1n);
      expect(bloomBitsetBytes(8n)).toBe(1n);
      expect(bloomBitsetBytes(9n)).toBe(2n);
      expect(bloomBitsetBytes(16n)).toBe(2n);
      expect(bloomBitsetBytes(17n)).toBe(3n);
    });

    it("should handle large values", () => {
      expect(bloomBitsetBytes(81920n)).toBe(10240n);
    });
  });

  describe("bloomRegionBytes", () => {
    it("should return HeaderBytesV1 + 4 * bitsetBytes", () => {
      const mBits = 80n; // 10 bytes per bitset
      const bitsetBytes = bloomBitsetBytes(mBits); // 10
      const expected = BigInt(Bloom.HeaderBytesV1) + 4n * bitsetBytes;
      expect(bloomRegionBytes(mBits)).toBe(expected);
    });

    it("should return just header for 0 mBits", () => {
      expect(bloomRegionBytes(0n)).toBe(BigInt(Bloom.HeaderBytesV1));
    });

    it("should calculate correctly for typical massif height 14", () => {
      // leafCount = 8192, mBits = 81920
      const mBits = 81920n;
      const bitsetBytes = (mBits + 7n) / 8n; // 10240
      const expected = 32n + 4n * bitsetBytes; // 32 + 40960 = 40992
      expect(bloomRegionBytes(mBits)).toBe(expected);
    });
  });

  describe("indexDataBytesV2", () => {
    it("should return 0 for 0 leaves", () => {
      expect(indexDataBytesV2(0n)).toBe(0n);
    });

    it("should throw on mBits overflow", () => {
      const hugeLeafCount = 0x100000000n;
      expect(() => indexDataBytesV2(hugeLeafCount)).toThrow(
        "bloom mBits overflow",
      );
    });

    it("should calculate correctly for height 1 (1 leaf)", () => {
      const leafCount = 1n;
      const mBits = bloomMBits(leafCount); // 10
      const bitsetBytes = bloomBitsetBytes(mBits); // 2
      const bloomBitsetsOnly = 4n * bitsetBytes; // 8
      const frontierBytes = BigInt(Urkle.FrontierStateV1Bytes); // 544
      const ltBytes = leafTableBytes(leafCount); // 128
      const nsBytes = nodeStoreBytes(leafCount); // 64

      const expected = bloomBitsetsOnly + frontierBytes + ltBytes + nsBytes;
      expect(indexDataBytesV2(leafCount)).toBe(expected);
    });

    it("should calculate correctly for height 14 (8192 leaves)", () => {
      const leafCount = 8192n;
      const mBits = bloomMBits(leafCount); // 81920
      const bitsetBytes = bloomBitsetBytes(mBits); // 10240
      const bloomBitsetsOnly = 4n * bitsetBytes; // 40960
      const frontierBytes = BigInt(Urkle.FrontierStateV1Bytes); // 544
      const ltBytes = leafTableBytes(leafCount); // 8192 * 128 = 1048576
      const nsBytes = nodeStoreBytes(leafCount); // 16383 * 64 = 1048512

      const expected = bloomBitsetsOnly + frontierBytes + ltBytes + nsBytes;
      expect(indexDataBytesV2(leafCount)).toBe(expected);
    });

    it("should increase with leaf count", () => {
      const size1 = indexDataBytesV2(1n);
      const size2 = indexDataBytesV2(2n);
      const size4 = indexDataBytesV2(4n);

      expect(size2).toBeGreaterThan(size1);
      expect(size4).toBeGreaterThan(size2);
    });
  });
});
