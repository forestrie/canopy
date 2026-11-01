/**
 * Known-answer vectors for leaf index -> massif index. The same table is
 * pinned in go-merklelog (massifs.MassifIndexFromLeafIndex) and in the
 * arbor ranger, so Go and TS agree on what a one-based massif height means:
 * a massif of height h holds 2^(h-1) leaves.
 */

import { describe, expect, it } from "vitest";

import {
  massifIndexFromLeafIndex,
  massifIndexFromMMRIndex,
  mmrIndex,
} from "../../src/index.js";

const KAT: { massifHeight: number; leafIndex: bigint; massifIndex: bigint }[] =
  [
    { massifHeight: 1, leafIndex: 0n, massifIndex: 0n },
    { massifHeight: 1, leafIndex: 1n, massifIndex: 1n },
    { massifHeight: 1, leafIndex: 2n, massifIndex: 2n },
    { massifHeight: 2, leafIndex: 0n, massifIndex: 0n },
    { massifHeight: 2, leafIndex: 1n, massifIndex: 0n },
    { massifHeight: 2, leafIndex: 2n, massifIndex: 1n },
    { massifHeight: 2, leafIndex: 3n, massifIndex: 1n },
    { massifHeight: 3, leafIndex: 3n, massifIndex: 0n },
    { massifHeight: 3, leafIndex: 4n, massifIndex: 1n },
    { massifHeight: 14, leafIndex: 0n, massifIndex: 0n },
    { massifHeight: 14, leafIndex: 8191n, massifIndex: 0n },
    { massifHeight: 14, leafIndex: 8192n, massifIndex: 1n },
    { massifHeight: 14, leafIndex: 16383n, massifIndex: 1n },
    { massifHeight: 14, leafIndex: 16384n, massifIndex: 2n },
  ];

describe("massifIndexFromLeafIndex (KAT)", () => {
  for (const { massifHeight, leafIndex, massifIndex } of KAT) {
    it(`h=${massifHeight} leaf ${leafIndex} -> massif ${massifIndex}`, () => {
      expect(massifIndexFromLeafIndex(massifHeight, leafIndex)).toBe(
        massifIndex,
      );
    });

    it(`h=${massifHeight} leaf ${leafIndex} agrees via the MMR index`, () => {
      expect(massifIndexFromMMRIndex(massifHeight, mmrIndex(leafIndex))).toBe(
        massifIndex,
      );
    });
  }

  it("accepts a number leaf index", () => {
    expect(massifIndexFromLeafIndex(14, 8192)).toBe(1n);
  });

  it("rejects massif height 0, which has no leaves", () => {
    expect(() => massifIndexFromLeafIndex(0, 0n)).toThrow(RangeError);
  });
});
