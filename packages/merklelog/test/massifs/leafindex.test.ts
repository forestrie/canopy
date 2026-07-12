import { describe, it, expect } from "vitest";
import {
  openMassifLeafIndex,
  MissingIndexError,
} from "../../src/massifs/leafindex.js";
import { buildV2Massif } from "../helpers/v2massif-fixture.js";

function value(fill: number): Uint8Array {
  return new Uint8Array(32).fill(fill);
}

describe("openMassifLeafIndex.findByContentHash (FOR-373)", () => {
  it("finds a leaf by content hash and returns its MMR index (height 3, massif 0)", () => {
    // 3 leaves -> log nodes n0,n1,n2,n3 (mmr 0,1,2,3); leaf ordinals 0,1,2 map
    // to mmr indices 0,1,3.
    const v0 = value(0x11);
    const v1 = value(0x22);
    const v2 = value(0x33);
    const { bytes } = buildV2Massif({
      massifHeight: 3,
      massifIndex: 0,
      logHashes: [value(0xa0), value(0xa1), value(0xa2), value(0xa3)],
      leafValues: [v0, v1, v2],
    });
    const idx = openMassifLeafIndex(bytes);
    expect(idx.leafCount).toBe(3);
    expect(idx.findByContentHash(v0)).toBe(0n);
    expect(idx.findByContentHash(v1)).toBe(1n);
    expect(idx.findByContentHash(v2)).toBe(3n);
  });

  it("finds leaves in a later massif with the right global MMR indices", () => {
    // Height-3 massif 1 begins at leaf index 4 (firstIndex mmr 7).
    // Leaf ordinals 0,1 -> global leaf indices 4,5 -> mmr indices 7,8.
    const v0 = value(0x44);
    const v1 = value(0x55);
    const { bytes } = buildV2Massif({
      massifHeight: 3,
      massifIndex: 1,
      logHashes: [value(0xb0), value(0xb1)],
      leafValues: [v0, v1],
    });
    const idx = openMassifLeafIndex(bytes);
    expect(idx.findByContentHash(v0)).toBe(7n);
    expect(idx.findByContentHash(v1)).toBe(8n);
  });

  it("findLeafByContentHash recovers the mmr index and idtimestamp key", () => {
    // buildV2Massif writes the leaf key as BigInt(ordinal + 1), big-endian.
    const v0 = value(0x11);
    const v1 = value(0x22);
    const v2 = value(0x33);
    const { bytes } = buildV2Massif({
      massifHeight: 3,
      massifIndex: 0,
      logHashes: [value(0xa0), value(0xa1), value(0xa2), value(0xa3)],
      leafValues: [v0, v1, v2],
    });
    const idx = openMassifLeafIndex(bytes);
    const be8 = (n: number): Uint8Array => {
      const out = new Uint8Array(8);
      new DataView(out.buffer).setBigUint64(0, BigInt(n), false);
      return out;
    };
    expect(idx.findLeafByContentHash(v0)).toEqual({
      mmrIndex: 0n,
      idtimestampBe8: be8(1),
    });
    expect(idx.findLeafByContentHash(v2)).toEqual({
      mmrIndex: 3n,
      idtimestampBe8: be8(3),
    });
    expect(idx.findLeafByContentHash(value(0x99))).toBeNull();
  });

  it("returns null for a hash that is absent (searched, not found)", () => {
    const { bytes } = buildV2Massif({
      massifHeight: 3,
      massifIndex: 0,
      logHashes: [value(0xa0), value(0xa1), value(0xa2), value(0xa3)],
      leafValues: [value(0x11), value(0x22), value(0x33)],
    });
    const idx = openMassifLeafIndex(bytes);
    expect(idx.findByContentHash(value(0x99))).toBeNull();
  });

  it("does not match unpopulated (zero) leaf-table slots", () => {
    // Only 2 leaves populated in a 4-capacity massif; the empty slots are all
    // zeros and a zero hash must not spuriously match.
    const { bytes } = buildV2Massif({
      massifHeight: 3,
      massifIndex: 0,
      logHashes: [value(0xa0), value(0xa1), value(0xa2)], // 2 leaves + interior
      leafValues: [value(0x11), value(0x22)],
    });
    const idx = openMassifLeafIndex(bytes);
    expect(idx.leafCount).toBe(2);
    expect(idx.findByContentHash(new Uint8Array(32))).toBeNull();
  });

  it("distinguishes absence-of-index from not-found via MissingIndexError", () => {
    const { bytes, peakStackStart } = buildV2Massif({
      massifHeight: 3,
      massifIndex: 0,
      logHashes: [value(0xa0), value(0xa1), value(0xa2), value(0xa3)],
      leafValues: [value(0x11)],
    });
    // Truncate before the index region is fully present (below peak-stack end).
    const truncated = bytes.slice(0, peakStackStart);
    expect(() => openMassifLeafIndex(truncated)).toThrow(MissingIndexError);
  });

  it("rejects a content hash of the wrong length", () => {
    const { bytes } = buildV2Massif({
      massifHeight: 3,
      massifIndex: 0,
      logHashes: [value(0xa0), value(0xa1), value(0xa2), value(0xa3)],
      leafValues: [value(0x11)],
    });
    const idx = openMassifLeafIndex(bytes);
    expect(() => idx.findByContentHash(new Uint8Array(16))).toThrow(/32 bytes/);
  });
});
