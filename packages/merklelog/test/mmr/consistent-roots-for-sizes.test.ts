/**
 * `consistentRootsForSizes`: the proof shape is fixed by the two sizes
 * (FOR-568, plan-2609-10 s4.3).
 *
 * A line-for-line port of the reference `consistent_roots_for_sizes`
 * (merkle-mountain-range-proofs `algorithms.py`) and of Solidity
 * `consistentRootsForSizes` (univocity `src/algorithms/consistentRoots.sol`).
 * Every method of the reference `TestConsistentRootsForSizes` is mirrored
 * here, pinned to the KAT-39 vectors.
 *
 * The oracle is the draft's published KAT-39 peak hashes, never another run
 * of the algorithm under test: the positive cases compare the proven roots
 * against the tabulated target accumulator, and each negative case names the
 * acceptance it prevents.
 */
import { beforeAll, describe, expect, it } from "vitest";
import {
  consistentRoots,
  consistentRootsForSizes,
  indexConsistencyProof,
  mmrSizeForLeafCount,
  peaksBitmap,
  ConsistencyPathLengthMismatch,
  ConsistencyPeakCountMismatch,
  ConsistencyRootMismatch,
  ConsistencyShapeError,
  IncompleteTreeSize,
  SizeMustIncrease,
} from "../../src/index.js";
import { createSyncHasher } from "../../src/mmr/algorithms-sync.js";
import type { NodeGetter } from "../../src/mmr/proof.js";
import type { Hasher } from "../../src/mmr/types.js";
import {
  COMPLETE_LAST_INDICES,
  KAT39_NODE_COUNT,
  buildKat39,
  katPeaks,
  toHex,
} from "../helpers/kat39.js";

/**
 * Every complete MMR last-index below 39 (reference `tableprint.py`
 * `complete_mmr_indices`). KAT-39 tabulates accumulators for a subset; the
 * full list is the known answer for the size arithmetic alone.
 */
const ALL_COMPLETE_LAST_INDICES = [
  0, 2, 3, 6, 7, 9, 10, 14, 15, 17, 18, 21, 22, 24, 25, 30, 31, 33, 34, 37, 38,
];

let hasher: Hasher;
let nodes: Uint8Array[];

const getHash: NodeGetter = (i) => nodes[Number(i)];

/** Proof paths, origin accumulator and target accumulator for a pair. */
function pair(ifrom: number, ito: number) {
  const proof = indexConsistencyProof(getHash, BigInt(ifrom), BigInt(ito));
  return {
    paths: proof.paths,
    accumulatorFrom: katPeaks(ifrom),
    toAccumulator: katPeaks(ito),
  };
}

/** The 36 growing pairs over the KAT-tabulated complete sizes. */
function growingPairs(): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (let i = 0; i < COMPLETE_LAST_INDICES.length; i++) {
    for (let j = 0; j < i; j++) {
      out.push([COMPLETE_LAST_INDICES[j], COMPLETE_LAST_INDICES[i]]);
    }
  }
  return out;
}

beforeAll(async () => {
  hasher = await createSyncHasher();
  nodes = await buildKat39(hasher);
});

describe("consistentRootsForSizes (KAT-39)", () => {
  it("matches consistentRoots and the target accumulator for every complete pair", async () => {
    let checked = 0;
    for (const [ifrom, ito] of growingPairs()) {
      const { paths, accumulatorFrom, toAccumulator } = pair(ifrom, ito);
      const { roots, expectedRight } = await consistentRootsForSizes(
        hasher,
        BigInt(ifrom) + 1n,
        BigInt(ito) + 1n,
        accumulatorFrom,
        paths,
      );
      const label = `MMR(${ifrom + 1}) -> MMR(${ito + 1})`;
      const shapeFree = await consistentRoots(
        hasher,
        BigInt(ifrom),
        accumulatorFrom,
        paths,
      );
      expect(roots.map(toHex), label).toEqual(shapeFree.map(toHex));
      // The published target accumulator is the oracle: the proven roots are
      // its leading entries and the remainder is the right-peak count.
      expect(roots.map(toHex), label).toEqual(
        toAccumulator.slice(0, roots.length).map(toHex),
      );
      expect(expectedRight, label).toBe(toAccumulator.length - roots.length);
      checked += 1;
    }
    expect(checked).toBe(36);
  });

  it("proves nothing from size 0 and counts every target peak as a right peak", async () => {
    for (const ito of COMPLETE_LAST_INDICES) {
      const { roots, expectedRight } = await consistentRootsForSizes(
        hasher,
        0n,
        BigInt(ito) + 1n,
        [],
        [],
      );
      expect(roots, `MMR(0) -> MMR(${ito + 1})`).toEqual([]);
      expect(expectedRight).toBe(katPeaks(ito).length);
    }
  });

  it("matches the draft worked example: MMR(8) -> MMR(11)", async () => {
    // Draft positions are 1-based. MMR(8)'s peaks sit at positions 7 and 8
    // (indices 6 and 7). Position 7 is still a peak of MMR(11) and is
    // returned unchanged; position 8 climbs one hop via position 9
    // (index 8). The third MMR(11) peak lies below both, so the prover
    // supplies it.
    const { paths, accumulatorFrom, toAccumulator } = pair(7, 10);
    expect(paths.map((p) => p.length)).toEqual([0, 1]);
    expect(toHex(paths[1][0])).toBe(toHex(nodes[8]));

    const { roots, expectedRight } = await consistentRootsForSizes(
      hasher,
      8n,
      11n,
      accumulatorFrom,
      paths,
    );
    expect(roots.map(toHex)).toEqual([
      toHex(toAccumulator[0]),
      toHex(toAccumulator[1]),
    ]);
    expect(expectedRight).toBe(1);
  });

  it("rejects sizes that do not grow", async () => {
    // Prevents a proof for a state that is not later than the trusted one
    // being accepted as evidence of growth.
    await expect(
      consistentRootsForSizes(hasher, 3n, 3n, [nodes[2]], [[]]),
    ).rejects.toBeInstanceOf(SizeMustIncrease);
    await expect(
      consistentRootsForSizes(hasher, 3n, 1n, [nodes[2]], [[]]),
    ).rejects.toBeInstanceOf(SizeMustIncrease);
  });

  it("rejects an incomplete target size", async () => {
    // peaksBitmap rounds an incomplete size down, so an incomplete target
    // would anchor the accumulator of a different tree than the one named.
    for (const sizeTo of [2n, 5n, 6n, 9n]) {
      await expect(
        consistentRootsForSizes(hasher, 1n, sizeTo, [nodes[0]], [[nodes[1]]]),
        `sizeTo ${sizeTo}`,
      ).rejects.toBeInstanceOf(IncompleteTreeSize);
    }
  });

  it("rejects an empty path where the sizes imply length 1", async () => {
    // Prevents an origin peak being re-anchored unchanged at a larger size
    // where it is no longer a peak.
    for (const sizeTo of [3n, 7n]) {
      await expect(
        consistentRootsForSizes(hasher, 1n, sizeTo, [nodes[0]], [[]]),
        `sizeTo ${sizeTo}`,
      ).rejects.toBeInstanceOf(ConsistencyPathLengthMismatch);
    }
  });

  it("rejects an accumulator or path count other than the origin peak count", async () => {
    // The origin peak count is fixed by sizeFrom alone; a short or long list
    // would otherwise let a peak go unproven.
    const { paths, accumulatorFrom } = pair(25, 38);
    await expect(
      consistentRootsForSizes(
        hasher,
        26n,
        39n,
        accumulatorFrom.slice(1),
        paths,
      ),
    ).rejects.toBeInstanceOf(ConsistencyPeakCountMismatch);
    await expect(
      consistentRootsForSizes(
        hasher,
        26n,
        39n,
        accumulatorFrom,
        paths.slice(1),
      ),
    ).rejects.toBeInstanceOf(ConsistencyPeakCountMismatch);
  });

  it("rejects any one path lengthened by a node, for every complete pair", async () => {
    // A path longer than the sizes imply would climb past the target peak
    // the sizes fix, so the length is checked before the path is read.
    let checked = 0;
    for (const [ifrom, ito] of growingPairs()) {
      const { paths, accumulatorFrom } = pair(ifrom, ito);
      for (let which = 0; which < paths.length; which++) {
        const perturbed = paths.map((p) => [...p]);
        perturbed[which] = [...perturbed[which], new Uint8Array(32)];
        await expect(
          consistentRootsForSizes(
            hasher,
            BigInt(ifrom) + 1n,
            BigInt(ito) + 1n,
            accumulatorFrom,
            perturbed,
          ),
          `MMR(${ifrom + 1}) -> MMR(${ito + 1}) path ${which}`,
        ).rejects.toBeInstanceOf(ConsistencyPathLengthMismatch);
        checked += 1;
      }
    }
    expect(checked).toBeGreaterThan(0);
  });

  it("rejects a changed sibling when two origin peaks share a target peak", async () => {
    // Two origin peaks below the split are committed by the same target
    // peak, so a change in one path makes the two prove different roots.
    let checked = 0;
    for (const [ifrom, ito] of growingPairs()) {
      const { paths, accumulatorFrom } = pair(ifrom, ito);
      if (paths.length < 2 || paths[paths.length - 2].length === 0) continue;
      const altered = paths.map((p) => [...p]);
      altered[altered.length - 1][0] = new Uint8Array(32).fill(0xff);
      await expect(
        consistentRootsForSizes(
          hasher,
          BigInt(ifrom) + 1n,
          BigInt(ito) + 1n,
          accumulatorFrom,
          altered,
        ),
        `MMR(${ifrom + 1}) -> MMR(${ito + 1})`,
      ).rejects.toBeInstanceOf(ConsistencyRootMismatch);
      checked += 1;
    }
    expect(checked).toBeGreaterThan(0);
  });

  it("every shape rejection is a ConsistencyShapeError", async () => {
    // Callers map the whole family to a malformed proof with one instanceof.
    await expect(
      consistentRootsForSizes(hasher, 3n, 3n, [nodes[2]], [[]]),
    ).rejects.toBeInstanceOf(ConsistencyShapeError);
    await expect(
      consistentRootsForSizes(hasher, 1n, 2n, [nodes[0]], [[nodes[1]]]),
    ).rejects.toBeInstanceOf(ConsistencyShapeError);
    await expect(
      consistentRootsForSizes(hasher, 1n, 3n, [nodes[0]], [[]]),
    ).rejects.toBeInstanceOf(ConsistencyShapeError);
  });

  it("mmrSizeForLeafCount(peaksBitmap(size)) === size exactly for complete sizes", async () => {
    // The identity the completeness test relies on. peaksBitmap(size) is the
    // reference `leaf_count(size - 1)`: it takes a node count, the reference
    // takes the last index.
    const complete = new Set(ALL_COMPLETE_LAST_INDICES.map((i) => i + 1));
    for (let size = 1; size <= KAT39_NODE_COUNT; size++) {
      const leaves = peaksBitmap(BigInt(size));
      expect(mmrSizeForLeafCount(leaves) === BigInt(size), `size ${size}`).toBe(
        complete.has(size),
      );
    }
  });
});
