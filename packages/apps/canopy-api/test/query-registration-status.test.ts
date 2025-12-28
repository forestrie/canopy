/**
 * Unit tests for query-registration-status byte-range read functionality.
 *
 * Tests the efficient idtimestamp reading from massif using R2 byte-range
 * requests. Verifies correct offset calculation and big-endian parsing.
 */

import { env } from "cloudflare:test";
import { describe, expect, it, beforeEach } from "vitest";
import {
  urkleLeafTableStartByteOffset,
  leafCountForMassifHeight,
} from "@canopy/merklelog";

import type { Env } from "../src/index";

// Cast the test env to our Env type.
const testEnv = env as unknown as Env;

/** Leaf record size in bytes */
const LEAF_RECORD_BYTES = 128;

/** ID timestamp size in bytes */
const IDTIMESTAMP_BYTES = 8;

/**
 * Build a minimal massif blob with specified idtimestamp values at leaf positions.
 *
 * The massif layout follows v2 format:
 * - Fixed header (256 bytes)
 * - Index header (32 bytes)
 * - Bloom bitsets
 * - Urkle frontier (544 bytes)
 * - Leaf table (128 bytes per leaf)
 * - Node store
 * - Peak stack (2048 bytes)
 * - Log data
 */
function buildMassifWithIdtimestamps(
  massifHeight: number,
  massifIndex: number,
  idtimestamps: Map<number, bigint>, // leafOrdinal -> idtimestamp
): Uint8Array {
  const VALUE_BYTES = 32;
  const RESERVED_HEADER_SLOTS = 7;
  const INDEX_HEADER_BYTES = 32;
  const MAX_MMR_HEIGHT = 64;

  const BLOOM_BITS_PER_ELEMENT_V1 = 10;
  const BLOOM_FILTERS = 4;
  const BLOOM_HEADER_BYTES_V1 = 32;

  const URKLE_FRONTIER_STATE_V1_BYTES = 544;
  const URKLE_LEAF_RECORD_BYTES = 128;
  const URKLE_NODE_RECORD_BYTES = 64;

  const leafCount = 1 << (massifHeight - 1);
  const mBits = BLOOM_BITS_PER_ELEMENT_V1 * leafCount;
  const bitsetBytes = Math.ceil(mBits / 8);
  const bloomRegionBytes = BLOOM_HEADER_BYTES_V1 + BLOOM_FILTERS * bitsetBytes;
  const bloomBitsetsBytes = bloomRegionBytes - BLOOM_HEADER_BYTES_V1;

  const leafTableBytes = leafCount * URKLE_LEAF_RECORD_BYTES;
  const nodeStoreBytes = (2 * leafCount - 1) * URKLE_NODE_RECORD_BYTES;
  const indexDataBytes =
    bloomBitsetsBytes +
    URKLE_FRONTIER_STATE_V1_BYTES +
    leafTableBytes +
    nodeStoreBytes;

  const fixedHeaderEnd = VALUE_BYTES + VALUE_BYTES * RESERVED_HEADER_SLOTS; // 256
  const trieHeaderEnd = fixedHeaderEnd + INDEX_HEADER_BYTES; // 288
  const peakStackStart = trieHeaderEnd + indexDataBytes;
  const logStart = peakStackStart + MAX_MMR_HEIGHT * VALUE_BYTES;

  // Minimal log data (just enough for tests)
  const logEntries = leafCount;
  const massifBytes = new Uint8Array(logStart + logEntries * VALUE_BYTES);
  const view = new DataView(massifBytes.buffer);

  // Massif start header fields
  view.setBigUint64(8, 0n, false); // lastID
  view.setUint16(21, 2, false); // version
  view.setUint32(23, 1, false); // commitmentEpoch
  massifBytes[27] = massifHeight;
  view.setUint32(28, massifIndex, false);

  // Write idtimestamps at leaf table positions
  const leafTableStart = urkleLeafTableStartByteOffset(massifHeight);
  for (const [leafOrdinal, idtimestamp] of idtimestamps) {
    const offset = leafTableStart + leafOrdinal * URKLE_LEAF_RECORD_BYTES;
    view.setBigUint64(offset, idtimestamp, false); // big-endian
  }

  return massifBytes;
}

describe("query-registration-status byte-range read", () => {
  const logId = "de305d54-75b4-431b-adb2-eb6b9e546014";

  beforeEach(async () => {
    // Clean up any existing test data
    const listed = await testEnv.R2_MMRS.list({
      prefix: "v2/merklelog/massifs/",
    });
    for (const obj of listed.objects) {
      await testEnv.R2_MMRS.delete(obj.key);
    }
  });

  describe("byte offset calculation", () => {
    it("calculates correct leaf table start for height 3", () => {
      const offset = urkleLeafTableStartByteOffset(3);
      // height 3 => 4 leaves
      // Fixed header: 256, Index header: 32
      // Bloom bitsets: 4 * ceil(10 * 4 / 8) = 4 * 5 = 20
      // Frontier: 544
      // Total: 256 + 32 + 20 + 544 = 852
      expect(offset).toBe(852);
    });

    it("calculates correct leaf table start for height 14", () => {
      const offset = urkleLeafTableStartByteOffset(14);
      // height 14 => 8192 leaves
      // Bloom bitsets: 4 * ceil(10 * 8192 / 8) = 4 * 10240 = 40960
      // Total: 256 + 32 + 40960 + 544 = 41792
      expect(offset).toBe(41792);
    });

    it("calculates correct leaves per massif for various heights", () => {
      expect(Number(leafCountForMassifHeight(1))).toBe(1);
      expect(Number(leafCountForMassifHeight(2))).toBe(2);
      expect(Number(leafCountForMassifHeight(3))).toBe(4);
      expect(Number(leafCountForMassifHeight(14))).toBe(8192);
    });
  });

  describe("mmrIndexFromLeafIndex", () => {
    // These test values match go-merklelog/mmr/mmrindex.go MMRIndex
    const testCases: [number, bigint][] = [
      [0, 0n],
      [1, 1n],
      [2, 3n],
      [3, 4n],
      [4, 7n],
      [5, 8n],
      [6, 10n],
      [7, 11n],
      [8, 15n],
      [100, 197n],
      [1000, 1994n], // Verified with go-merklelog
    ];

    // Import the function for testing (we'll inline the implementation since it's not exported)
    function mmrIndexFromLeafIndex(leafIndex: number): bigint {
      let sum = 0n;
      let current = BigInt(leafIndex);

      while (current > 0n) {
        const h = BigInt(current.toString(2).length);
        sum += (1n << h) - 1n;
        const half = 1n << (h - 1n);
        current -= half;
      }

      return sum;
    }

    for (const [leafIndex, expectedMmrIndex] of testCases) {
      it(`converts leaf index ${leafIndex} to MMR index ${expectedMmrIndex}`, () => {
        expect(mmrIndexFromLeafIndex(leafIndex)).toBe(expectedMmrIndex);
      });
    }
  });

  describe("R2 byte-range read", () => {
    it("reads idtimestamp from first leaf in massif (ordinal 0)", async () => {
      const massifHeight = 3;
      const massifIndex = 0;
      const expectedIdtimestamp = 0x0102030405060708n;

      const massifBytes = buildMassifWithIdtimestamps(
        massifHeight,
        massifIndex,
        new Map([[0, expectedIdtimestamp]]),
      );

      const objectKey = `v2/merklelog/massifs/${massifHeight}/${logId}/0000000000000000.log`;
      await testEnv.R2_MMRS.put(objectKey, massifBytes);

      // Read using byte-range
      const leafTableStart = urkleLeafTableStartByteOffset(massifHeight);
      const object = await testEnv.R2_MMRS.get(objectKey, {
        range: { offset: leafTableStart, length: IDTIMESTAMP_BYTES },
      });

      expect(object).not.toBeNull();
      const data = await object!.arrayBuffer();
      expect(data.byteLength).toBe(IDTIMESTAMP_BYTES);

      const view = new DataView(data);
      const idtimestamp = view.getBigUint64(0, false);
      expect(idtimestamp).toBe(expectedIdtimestamp);
    });

    it("reads idtimestamp from middle leaf in massif (ordinal 2)", async () => {
      const massifHeight = 3;
      const massifIndex = 0;
      const leafOrdinal = 2;
      const expectedIdtimestamp = 0xdeadbeefcafebaben;

      const massifBytes = buildMassifWithIdtimestamps(
        massifHeight,
        massifIndex,
        new Map([[leafOrdinal, expectedIdtimestamp]]),
      );

      const objectKey = `v2/merklelog/massifs/${massifHeight}/${logId}/0000000000000000.log`;
      await testEnv.R2_MMRS.put(objectKey, massifBytes);

      // Read using byte-range
      const leafTableStart = urkleLeafTableStartByteOffset(massifHeight);
      const offset = leafTableStart + leafOrdinal * LEAF_RECORD_BYTES;
      const object = await testEnv.R2_MMRS.get(objectKey, {
        range: { offset, length: IDTIMESTAMP_BYTES },
      });

      expect(object).not.toBeNull();
      const data = await object!.arrayBuffer();
      const view = new DataView(data);
      const idtimestamp = view.getBigUint64(0, false);
      expect(idtimestamp).toBe(expectedIdtimestamp);
    });

    it("reads idtimestamp from last leaf in massif (ordinal 3 for height 3)", async () => {
      const massifHeight = 3;
      const massifIndex = 0;
      const leafOrdinal = 3; // Last leaf for height 3 (4 leaves total)
      const expectedIdtimestamp = 0xffeeddccbbaa9988n;

      const massifBytes = buildMassifWithIdtimestamps(
        massifHeight,
        massifIndex,
        new Map([[leafOrdinal, expectedIdtimestamp]]),
      );

      const objectKey = `v2/merklelog/massifs/${massifHeight}/${logId}/0000000000000000.log`;
      await testEnv.R2_MMRS.put(objectKey, massifBytes);

      // Read using byte-range
      const leafTableStart = urkleLeafTableStartByteOffset(massifHeight);
      const offset = leafTableStart + leafOrdinal * LEAF_RECORD_BYTES;
      const object = await testEnv.R2_MMRS.get(objectKey, {
        range: { offset, length: IDTIMESTAMP_BYTES },
      });

      expect(object).not.toBeNull();
      const data = await object!.arrayBuffer();
      const view = new DataView(data);
      const idtimestamp = view.getBigUint64(0, false);
      expect(idtimestamp).toBe(expectedIdtimestamp);
    });

    it("reads from second massif (massifIndex = 1)", async () => {
      const massifHeight = 3;
      const massifIndex = 1;
      const leafOrdinal = 0;
      const expectedIdtimestamp = 0x1111222233334444n;

      const massifBytes = buildMassifWithIdtimestamps(
        massifHeight,
        massifIndex,
        new Map([[leafOrdinal, expectedIdtimestamp]]),
      );

      // Note: massifIndex 1 should be padded to "0000000000000001"
      const objectKey = `v2/merklelog/massifs/${massifHeight}/${logId}/0000000000000001.log`;
      await testEnv.R2_MMRS.put(objectKey, massifBytes);

      const leafTableStart = urkleLeafTableStartByteOffset(massifHeight);
      const object = await testEnv.R2_MMRS.get(objectKey, {
        range: { offset: leafTableStart, length: IDTIMESTAMP_BYTES },
      });

      expect(object).not.toBeNull();
      const data = await object!.arrayBuffer();
      const view = new DataView(data);
      const idtimestamp = view.getBigUint64(0, false);
      expect(idtimestamp).toBe(expectedIdtimestamp);
    });

    it("computes correct leaf ordinal from global leaf index", () => {
      const massifHeight = 3;
      const leavesPerMassif = Number(leafCountForMassifHeight(massifHeight)); // 4

      // Global leaf indices and expected ordinals
      expect(0 % leavesPerMassif).toBe(0); // First leaf of massif 0
      expect(3 % leavesPerMassif).toBe(3); // Last leaf of massif 0
      expect(4 % leavesPerMassif).toBe(0); // First leaf of massif 1
      expect(7 % leavesPerMassif).toBe(3); // Last leaf of massif 1
      expect(100 % leavesPerMassif).toBe(0); // First leaf of massif 25
    });

    it("returns null for non-existent massif", async () => {
      const objectKey = `v2/merklelog/massifs/3/${logId}/9999999999999999.log`;
      const object = await testEnv.R2_MMRS.get(objectKey, {
        range: { offset: 0, length: 8 },
      });
      expect(object).toBeNull();
    });
  });

  describe("hexToBuffer", () => {
    function hexToBuffer(hex: string): ArrayBuffer {
      const bytes = new Uint8Array(hex.length / 2);
      for (let i = 0; i < hex.length; i += 2) {
        bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
      }
      return bytes.buffer;
    }

    it("converts 64-char hex to 32-byte ArrayBuffer", () => {
      const hex = "ab".repeat(32);
      const buffer = hexToBuffer(hex);
      expect(buffer.byteLength).toBe(32);
      const arr = new Uint8Array(buffer);
      for (let i = 0; i < 32; i++) {
        expect(arr[i]).toBe(0xab);
      }
    });

    it("converts mixed hex values correctly", () => {
      const hex = "0102030405060708";
      const buffer = hexToBuffer(hex);
      const arr = new Uint8Array(buffer);
      expect(arr).toEqual(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]));
    });
  });

  describe("massif index padding", () => {
    it("pads single digit to 16 characters", () => {
      expect((0).toString().padStart(16, "0")).toBe("0000000000000000");
      expect((1).toString().padStart(16, "0")).toBe("0000000000000001");
      expect((9).toString().padStart(16, "0")).toBe("0000000000000009");
    });

    it("pads larger numbers correctly", () => {
      expect((123).toString().padStart(16, "0")).toBe("0000000000000123");
      expect((999999999).toString().padStart(16, "0")).toBe("0000000999999999");
    });
  });

  describe("big-endian reading", () => {
    it("reads big-endian uint64 correctly", () => {
      // Create buffer with known big-endian value
      const buffer = new ArrayBuffer(8);
      const view = new DataView(buffer);
      view.setBigUint64(0, 0x0102030405060708n, false); // big-endian

      // Verify raw bytes are in big-endian order
      const bytes = new Uint8Array(buffer);
      expect(bytes).toEqual(
        new Uint8Array([0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08]),
      );

      // Verify reading back
      const readValue = view.getBigUint64(0, false);
      expect(readValue).toBe(0x0102030405060708n);
    });

    it("distinguishes big-endian from little-endian", () => {
      const buffer = new ArrayBuffer(8);
      const view = new DataView(buffer);
      view.setBigUint64(0, 0x0102030405060708n, false); // big-endian

      // Reading as little-endian gives different result
      const leValue = view.getBigUint64(0, true);
      expect(leValue).not.toBe(0x0102030405060708n);
      expect(leValue).toBe(0x0807060504030201n);
    });
  });
});
