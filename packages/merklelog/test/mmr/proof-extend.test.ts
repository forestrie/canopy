/**
 * FOR-418 Phase 3 (plan-2607-32): `inclusionProofPath` and
 * `inclusionProofLocalExtend` — the tile-free proof-extension primitives ported
 * from go-merklelog (`mmr/proof.go` InclusionProofPath, `mmr/proofrefresh.go`
 * InclusionProofLocalExtend). Grounded in the canonical KAT-39 MMR (same fixture
 * as consistency.test.ts) and cross-checked against the already-KAT-verified
 * `inclusionProof` / `calculateRoot`, so these ports inherit Go parity.
 */
import { beforeAll, describe, expect, it } from "vitest";
import {
  inclusionProof,
  inclusionProofPath,
  inclusionProofLocalExtend,
} from "../../src/mmr/proof.js";
import { indexHeight, type NodeGetter } from "../../src/mmr/proof.js";
import { calculateRoot } from "../../src/mmr/algorithms.js";
import { createSyncHasher } from "../../src/mmr/algorithms-sync.js";
import { mmrIndex } from "../../src/mmr/index.js";
import type { Hasher } from "../../src/mmr/types.js";

const KAT39_LEAF_COUNT = 21;
const toHex = (b: Uint8Array) =>
  Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

let hasher: Hasher;
let nodes: Uint8Array[];

async function addLeaf(all: Uint8Array[], leaf: Uint8Array): Promise<void> {
  all.push(leaf);
  let g = 0;
  while (indexHeight(BigInt(all.length)) > g) {
    const right = all[all.length - 1]!;
    const left = all[all.length - (2 ** (g + 1) - 1) - 1]!;
    const posBytes = new Uint8Array(8);
    new DataView(posBytes.buffer).setBigUint64(0, BigInt(all.length + 1));
    hasher.reset();
    hasher.update(posBytes);
    hasher.update(left);
    hasher.update(right);
    all.push(await hasher.digest());
    g += 1;
  }
}

const get: NodeGetter = (i) => nodes[Number(i)]!;

beforeAll(async () => {
  hasher = await createSyncHasher();
  nodes = [];
  for (let j = 0; j < KAT39_LEAF_COUNT; j++) {
    const be8 = new Uint8Array(8);
    new DataView(be8.buffer).setBigUint64(0, mmrIndex(BigInt(j)));
    hasher.reset();
    hasher.update(be8);
    await addLeaf(nodes, await hasher.digest());
  }
  expect(nodes.length).toBe(39);
});

/** Record the indices `inclusionProof` reads, to compare with the index-only path. */
function proofReadIndices(mmrLastIndex: bigint, i: bigint): bigint[] {
  const seen: bigint[] = [];
  inclusionProof(
    (ix) => {
      seen.push(ix);
      return get(ix);
    },
    mmrLastIndex,
    i,
  );
  return seen;
}

describe("inclusionProofPath (index-only)", () => {
  it("returns exactly the indices inclusionProof reads (all nodes, several sizes)", () => {
    for (const lastIndex of [2n, 6n, 10n, 14n, 25n, 38n]) {
      for (let i = 0n; i <= lastIndex; i++) {
        expect(inclusionProofPath(lastIndex, i)).toEqual(
          proofReadIndices(lastIndex, i),
        );
      }
    }
  });

  it("its values recompute the covering peak (KAT-39 node values)", async () => {
    // leaf 0 at size 15 (last index 14): single peak node 14.
    const path = inclusionProofPath(14n, 0n).map(get);
    const root = await calculateRoot(
      hasher,
      get(0n),
      { path, mmrIndex: 0n },
      0n,
    );
    expect(toHex(root)).toBe(toHex(get(14n)));
  });
});

describe("inclusionProofLocalExtend", () => {
  // (leaf MMR index, complete size A, complete size B), all A < B.
  const cases: [bigint, bigint, bigint][] = [
    [0n, 3n, 7n],
    [0n, 7n, 15n],
    [0n, 3n, 15n],
    [1n, 3n, 7n],
    [1n, 3n, 39n],
    [3n, 4n, 7n], // leaf index 3 (leaf ordinal 2)
    [7n, 8n, 15n], // leaf index 7 (leaf ordinal 4)
    [0n, 15n, 39n],
  ];

  it.each(cases)(
    "extends node %s from size %s to size %s: prefix identity + recomputes the size-B peak",
    async (leaf, sizeA, sizeB) => {
      const ext = inclusionProofLocalExtend(get, sizeA, sizeB, leaf);

      // (1) prefix identity: path[0..heightA] IS the size-A inclusion proof.
      const sizeAProof = inclusionProof(get, sizeA - 1n, leaf);
      expect(ext.path.slice(0, ext.heightA).map(toHex)).toEqual(
        sizeAProof.map(toHex),
      );

      // (2) the extended path's node indices == the index-only path at size B.
      expect(
        inclusionProofPath(sizeB - 1n, leaf)
          .map(get)
          .map(toHex),
      ).toEqual(ext.path.map(toHex));

      // (3) the extended path recomputes the covering peak at size B — the
      // real KAT-39 node value at peakIndexB (soundness against actual nodes).
      const root = await calculateRoot(
        hasher,
        get(leaf),
        { path: ext.path, mmrIndex: leaf },
        leaf,
      );
      expect(toHex(root)).toBe(toHex(get(ext.peakIndexB)));
    },
  );

  it("heightA equals the length of the size-A proof", () => {
    const ext = inclusionProofLocalExtend(get, 7n, 39n, 0n);
    expect(ext.heightA).toBe(inclusionProof(get, 6n, 0n).length);
  });

  it("rejects a non-growing extension", () => {
    expect(() => inclusionProofLocalExtend(get, 7n, 7n, 0n)).toThrow(
      /must be greater/,
    );
    expect(() => inclusionProofLocalExtend(get, 7n, 3n, 0n)).toThrow(
      /must be greater/,
    );
  });
});
