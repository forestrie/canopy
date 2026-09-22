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
  ConsistencyPathMalformed,
  ConsistencyRootMismatch,
  ConsistencyShapeError,
  IncompleteTreeSize,
  SizeMustIncrease,
  SizeNotUint64,
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

/**
 * The sizes are `uint64` in Solidity and Go; `bigint` carries no bound, so
 * the fold states the domain itself (review finding C5). Above the bound the
 * position prefix `hash_pospair64` commits is truncated to eight bytes, so
 * the roots computed there are not the ones the other two implementations
 * would compute — and no CBOR unsigned integer can carry such a size anyway.
 */
describe("consistentRootsForSizes uint64 domain", () => {
  const MAX = (1n << 64n) - 1n;

  it("accepts the largest uint64 size", async () => {
    // 2^64 - 1 is a complete (perfect) MMR size; with no origin peaks there
    // is nothing to fold, so this reaches the early return.
    const { roots, expectedRight } = await consistentRootsForSizes(
      hasher,
      0n,
      MAX,
      [],
      [],
    );
    expect(roots).toEqual([]);
    expect(expectedRight).toBe(1);
  });

  it("rejects a target size one above the largest uint64", async () => {
    await expect(
      consistentRootsForSizes(hasher, 0n, 1n << 64n, [], []),
    ).rejects.toBeInstanceOf(SizeNotUint64);
  });

  it("rejects a target size of 2^65 - 1", async () => {
    // A complete MMR size with 2^64 leaves: complete, and still out of
    // domain. Accepted before the bound was stated.
    await expect(
      consistentRootsForSizes(hasher, 0n, (1n << 65n) - 1n, [], []),
    ).rejects.toBeInstanceOf(SizeNotUint64);
    await expect(
      consistentRootsForSizes(
        hasher,
        1n,
        (1n << 65n) - 1n,
        [nodes[0]],
        [Array.from({ length: 64 }, () => new Uint8Array(32).fill(1))],
      ),
    ).rejects.toBeInstanceOf(SizeNotUint64);
  });

  it("rejects an origin size above the largest uint64", async () => {
    await expect(
      consistentRootsForSizes(hasher, 1n << 64n, (1n << 64n) + 2n, [], []),
    ).rejects.toBeInstanceOf(SizeNotUint64);
  });

  it("rejects a negative size", async () => {
    await expect(
      consistentRootsForSizes(hasher, -1n, 3n, [], []),
    ).rejects.toBeInstanceOf(SizeNotUint64);
  });

  it("an out-of-domain size is a ConsistencyShapeError", async () => {
    await expect(
      consistentRootsForSizes(hasher, 0n, 1n << 64n, [], []),
    ).rejects.toBeInstanceOf(ConsistencyShapeError);
  });
});

/**
 * `paths` material that is not a dense `Uint8Array[][]` survives the peak
 * COUNT check and used to surface as a bare `TypeError`, outside the
 * `ConsistencyShapeError` family callers switch on (review finding C6).
 */
describe("consistentRootsForSizes paths shape", () => {
  /** MMR(11) -> MMR(39): three origin peaks, so three paths. */
  const ELEVEN_TO_39 = () => pair(10, 38);

  it("rejects null in place of the paths array", async () => {
    const { accumulatorFrom } = ELEVEN_TO_39();
    await expect(
      consistentRootsForSizes(
        hasher,
        11n,
        39n,
        accumulatorFrom,
        null as unknown as Uint8Array[][],
      ),
    ).rejects.toBeInstanceOf(ConsistencyPathMalformed);
  });

  it("rejects a sparse paths array of the right length", async () => {
    const { accumulatorFrom } = ELEVEN_TO_39();
    const sparse = new Array<Uint8Array[]>(3);
    expect(sparse.length).toBe(3);
    await expect(
      consistentRootsForSizes(hasher, 11n, 39n, accumulatorFrom, sparse),
    ).rejects.toBeInstanceOf(ConsistencyPathMalformed);
  });

  it("rejects a null path", async () => {
    const { accumulatorFrom } = ELEVEN_TO_39();
    await expect(
      consistentRootsForSizes(hasher, 11n, 39n, accumulatorFrom, [
        null,
        null,
        null,
      ] as unknown as Uint8Array[][]),
    ).rejects.toBeInstanceOf(ConsistencyPathMalformed);
  });

  it("rejects a path that is not an array", async () => {
    const { paths, accumulatorFrom } = ELEVEN_TO_39();
    const mangled = [...paths];
    mangled[0] = "not-an-array" as unknown as Uint8Array[];
    await expect(
      consistentRootsForSizes(hasher, 11n, 39n, accumulatorFrom, mangled),
    ).rejects.toBeInstanceOf(ConsistencyPathMalformed);
  });

  it("rejects a path element that is not a Uint8Array", async () => {
    const { paths, accumulatorFrom } = ELEVEN_TO_39();
    const mangled = paths.map((p) => [...p]);
    mangled[0][0] = "not-bytes" as unknown as Uint8Array;
    await expect(
      consistentRootsForSizes(hasher, 11n, 39n, accumulatorFrom, mangled),
    ).rejects.toBeInstanceOf(ConsistencyPathMalformed);
  });

  it("a malformed paths array is a ConsistencyShapeError", async () => {
    const { accumulatorFrom } = ELEVEN_TO_39();
    await expect(
      consistentRootsForSizes(
        hasher,
        11n,
        39n,
        accumulatorFrom,
        new Array<Uint8Array[]>(3),
      ),
    ).rejects.toBeInstanceOf(ConsistencyShapeError);
  });
});
