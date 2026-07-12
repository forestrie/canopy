import { describe, it, expect } from "vitest";
import { openMassifNodeStore } from "../../src/massifs/nodestore.js";
import { buildV2Massif } from "../helpers/v2massif-fixture.js";

function node(fill: number): Uint8Array {
  return new Uint8Array(32).fill(fill);
}

describe("openMassifNodeStore", () => {
  it("reads log-region nodes by MMR index (massif 0, height 3)", () => {
    // 3 leaves, size 4: nodes n0,n1,n2,n3 at mmr indices 0,1,2,3.
    const logHashes = [node(0xa0), node(0xa1), node(0xa2), node(0xa3)];
    const { bytes } = buildV2Massif({
      massifHeight: 3,
      massifIndex: 0,
      logHashes,
    });
    const store = openMassifNodeStore(bytes);
    expect(store.massifHeight).toBe(3);
    expect(store.massifIndex).toBe(0n);
    expect(store.firstIndex).toBe(0n);
    expect(store.lastIndex).toBe(3n);
    for (let i = 0n; i <= 3n; i++) {
      expect(store.get(i)).toEqual(logHashes[Number(i)]);
    }
  });

  it("throws for a node beyond the local log data", () => {
    const { bytes } = buildV2Massif({
      massifHeight: 3,
      massifIndex: 0,
      logHashes: [node(1), node(2), node(3), node(4)],
    });
    const store = openMassifNodeStore(bytes);
    expect(() => store.get(4n)).toThrow(/beyond this massif/);
  });

  it("resolves an ancestor peak from the fixed peak stack (massif 1)", () => {
    // Height-3 massif 1 begins at firstIndex 7; n6 (ancestor peak of massif 0)
    // lives in peak-stack slot 0.
    const ancestor = node(0xee);
    const { bytes, peakStackStart } = buildV2Massif({
      massifHeight: 3,
      massifIndex: 1,
      logHashes: [node(0xb0), node(0xb1)],
    });
    // Write the ancestor peak into peak-stack slot 0.
    bytes.set(ancestor, peakStackStart);
    const store = openMassifNodeStore(bytes);
    expect(store.firstIndex).toBe(7n);
    expect(store.get(6n)).toEqual(ancestor);
    // A local node still reads from the log region.
    expect(store.get(7n)).toEqual(node(0xb0));
  });

  it("throws for an ancestor index with no peak-stack slot", () => {
    const { bytes } = buildV2Massif({
      massifHeight: 3,
      massifIndex: 1,
      logHashes: [node(1), node(2)],
    });
    const store = openMassifNodeStore(bytes);
    // index 0 is below firstIndex but is not an ancestor peak of massif 1.
    expect(() => store.get(0n)).toThrow(/missing ancestor peak/);
  });
});
