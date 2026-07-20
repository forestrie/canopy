import { describe, it, expect, beforeAll } from "vitest";
import {
  inclusionProof,
  indexHeight,
  peakMMRIndexes,
  peaksBitmap,
  peakIndexForLeafProof,
  firstMMRSize,
  massifIndexFromMMRIndex,
  peakStackMap,
} from "../../src/mmr/proof.js";
import { calculateRoot } from "../../src/mmr/algorithms.js";
import type { Proof } from "../../src/mmr/types.js";
import {
  Sha256Hasher,
  hexToBytes,
  bytesToHex,
} from "../helpers/sha256-hasher.js";

/**
 * Non-circular parity tests for the hoisted proof builder against the
 * canonical MMR(39) from go-merklelog `draft_kat39_test.go` (plan-2607-15 §4).
 * The node table is rebuilt independently (faithful AddHashedLeaf port) and
 * the golden peak hashes are copied verbatim from KAT39 — none of it is
 * derived from the code under test.
 */

const KAT39_LEAVES: string[] = [
  "af5570f5a1810b7af78caf4bc70a660f0df51e42baf91d4de5b2328de0e83dfc",
  "cd2662154e6d76b2b2b92e70c0cac3ccf534f9b74eb5b89819ec509083d00a50",
  "d5688a52d55a02ec4aea5ec1eadfffe1c9e0ee6a4ddbe2377f98326d42dfc975",
  "8005f02d43fa06e7d0585fb64c961d57e318b27a145c857bcd3a6bdb413ff7fc",
  "a3eb8db89fc5123ccfd49585059f292bc40a1c0d550b860f24f84efb4760fbf2",
  "4c0e071832d527694adea57b50dd7b2164c2a47c02940dcf26fa07c44d6d222a",
  "8d85f8467240628a94819b26bee26e3a9b2804334c63482deacec8d64ab4e1e7",
  "0b5000b73a53f0916c93c68f4b9b6ba8af5a10978634ae4f2237e1f3fbe324fa",
  "e66c57014a6156061ae669809ec5d735e484e8fcfd540e110c9b04f84c0b4504",
  "998e907bfbb34f71c66b6dc6c40fe98ca6d2d5a29755bc5a04824c36082a61d1",
  "5bc67471c189d78c76461dcab6141a733bdab3799d1d69e0c419119c92e82b3d",
  "1b8d0103e3a8d9ce8bda3bff71225be4b5bb18830466ae94f517321b7ecc6f94",
  "7a42e3892368f826928202014a6ca95a3d8d846df25088da80018663edf96b1c",
  "aed2b8245fdc8acc45eda51abc7d07e612c25f05cadd1579f3474f0bf1f6bdc6",
  "561f627b4213258dc8863498bb9b07c904c3c65a78c1a36bca329154d1ded213",
  "1209fe3bc3497e47376dfbd9df0600a17c63384c85f859671956d8289e5a0be8",
  "1664a6e0ea12d234b4911d011800bb0f8c1101a0f9a49a91ee6e2493e34d8e7b",
  "707d56f1f282aee234577e650bea2e7b18bb6131a499582be18876aba99d4b60",
  "4d75f61869104baa4ccff5be73311be9bdd6cc31779301dfc699479403c8a786",
  "0764c726a72f8e1d245f332a1d022fffdada0c4cb2a016886e4b33b66cb9a53f",
  "e9a5f5201eb3c3c856e0a224527af5ac7eb1767fb1aff9bd53ba41a60cde9785",
];

const MMR39_LAST_INDEX = 38n;
// Peaks of the full MMR(39): node indices 30, 37, 38.
const KAT39_FULL_PEAKS = [30, 37, 38];

// Height index per node (0..38) from the canonical tree structure.
const KAT39_NODE_HEIGHTS: number[] = (() => {
  const h = new Array<number>(39).fill(0);
  for (const i of [2, 5, 9, 12, 17, 20, 24, 27, 33, 36]) h[i] = 1;
  for (const i of [6, 13, 21, 28, 37]) h[i] = 2;
  for (const i of [14, 29]) h[i] = 3;
  h[30] = 4;
  return h;
})();

function u64be(value: bigint): Uint8Array {
  const out = new Uint8Array(8);
  let v = value & 0xffffffffffffffffn;
  for (let i = 7; i >= 0; i--) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}

/** Faithful port of go-merklelog AddHashedLeaf, independent of code under test. */
async function buildNodeTable(leafHashes: Uint8Array[]): Promise<Uint8Array[]> {
  const nodes: Uint8Array[] = [];
  const hasher = new Sha256Hasher();
  for (const leaf of leafHashes) {
    nodes.push(leaf);
    let i = BigInt(nodes.length);
    let height = 0;
    while (indexHeight(i) > height) {
      const iLeft = i - (2n << BigInt(height));
      const iRight = i - 1n;
      hasher.reset();
      hasher.update(u64be(i + 1n));
      hasher.update(nodes[Number(iLeft)]!);
      hasher.update(nodes[Number(iRight)]!);
      nodes.push(await hasher.digest());
      i = BigInt(nodes.length);
      height += 1;
    }
  }
  return nodes;
}

function coveringPeak(i: bigint): number {
  if (i <= 30n) return 30;
  if (i <= 37n) return 37;
  return 38;
}

describe("mmr/proof (hoisted builder) — MMR(39) KAT parity", () => {
  let nodes: Uint8Array[];

  beforeAll(async () => {
    nodes = await buildNodeTable(KAT39_LEAVES.map(hexToBytes));
  });

  it("indexHeight matches the canonical heights for all 39 nodes", () => {
    for (let i = 0; i < 39; i++) {
      expect(indexHeight(BigInt(i))).toBe(KAT39_NODE_HEIGHTS[i]);
    }
  });

  it("inclusionProof + calculateRoot reproduce the covering peak for every node", async () => {
    const hasher = new Sha256Hasher();
    const get = (i: bigint) => nodes[Number(i)]!;
    for (let n = 0n; n <= MMR39_LAST_INDEX; n++) {
      const path = inclusionProof(get, MMR39_LAST_INDEX, n);
      const proof: Proof = { path, mmrIndex: n };
      const root = await calculateRoot(hasher, nodes[Number(n)]!, proof, n);
      expect(bytesToHex(root)).toBe(bytesToHex(nodes[coveringPeak(n)]!));
    }
  });

  it("peakIndexForLeafProof selects the accumulator slot the covering peak sits in", () => {
    // Full MMR(39) accumulator is [n30, n37, n38] (slots 0,1,2), descending
    // height. peakIndexForLeafProof is defined over *leaf* proofs, so restrict
    // to the 21 leaves (height-0 nodes).
    const get = (i: bigint) => nodes[Number(i)]!;
    const slotOf = new Map<number, number>([
      [30, 0],
      [37, 1],
      [38, 2],
    ]);
    for (let n = 0n; n <= MMR39_LAST_INDEX; n++) {
      if (indexHeight(n) !== 0) continue; // leaves only
      const path = inclusionProof(get, MMR39_LAST_INDEX, n);
      const slot = peakIndexForLeafProof(MMR39_LAST_INDEX + 1n, path.length);
      expect(slot).toBe(slotOf.get(coveringPeak(n)));
    }
  });

  it("peakMMRIndexes returns the accumulator peak indices ascending", () => {
    expect(peakMMRIndexes(MMR39_LAST_INDEX)).toEqual(
      KAT39_FULL_PEAKS.map((i) => BigInt(i)),
    );
    // Single perfect subtree (size 1): the leaf is its own peak.
    expect(peakMMRIndexes(0n)).toEqual([0n]);
    // Size 4 (3 leaves): peaks at n2, n3.
    expect(peakMMRIndexes(3n)).toEqual([2n, 3n]);
  });

  it("peakMMRIndexes rejects a non-positive size in bounded time (FOR-414)", () => {
    // mmrIndex -1 → mmrSize 0 → posHeight(0) once spun forever, hanging any
    // caller fed a malformed size (a corrupt/hostile checkpoint). It must
    // throw, not loop.
    expect(() => peakMMRIndexes(-1n)).toThrow(/position must be >= 1/);
    expect(() => peakMMRIndexes(-6n)).toThrow(/position must be >= 1/);
    expect(() => indexHeight(-1n)).toThrow(/position must be >= 1/);
  });

  it("peaksBitmap equals the leaf count of the largest valid MMR <= size", () => {
    // Complete sizes and their leaf counts (KAT39CompleteMMRSizes).
    const sizeToLeaves: Array<[bigint, bigint]> = [
      [1n, 1n],
      [3n, 2n],
      [4n, 3n],
      [7n, 4n],
      [8n, 5n],
      [39n, 21n],
    ];
    for (const [size, leaves] of sizeToLeaves) {
      expect(peaksBitmap(size)).toBe(leaves);
    }
  });

  it("firstMMRSize returns the smallest complete size containing a node", () => {
    // leaf 0 first completes at size 1; leaf 1 (index 1) at size 3 (with n2).
    expect(firstMMRSize(0n)).toBe(1n);
    expect(firstMMRSize(1n)).toBe(3n);
    // interior node 2 (height 1) completes at size 3; leaf 3 (index 3) at size 4.
    expect(firstMMRSize(2n)).toBe(3n);
    expect(firstMMRSize(3n)).toBe(4n);
    // interior node 6 (height 2, root of 4 leaves) completes at size 7.
    expect(firstMMRSize(6n)).toBe(7n);
  });

  it("massifIndexFromMMRIndex places nodes in the right height-3 massif", () => {
    // height 3 => 4 leaves per massif (massifMaxLeaves = 1<<2 = 4).
    // leaves 0..3 (mmr idx 0,1,3,4) live in massif 0; leaf 4 (mmr idx 7) in massif 1.
    expect(massifIndexFromMMRIndex(3, 0n)).toBe(0n);
    expect(massifIndexFromMMRIndex(3, 4n)).toBe(0n);
    expect(massifIndexFromMMRIndex(3, 7n)).toBe(1n);
    expect(massifIndexFromMMRIndex(3, 8n)).toBe(1n);
  });

  it("peakStackMap is empty for the first massif and populated for later ones", () => {
    // Massif 0 begins at firstIndex 0, no ancestors.
    expect(peakStackMap(3, 0n).size).toBe(0);
    // Massif 1 (height 3) begins at firstIndex 7; the prior massif's peak (n6)
    // is an ancestor available in the stack.
    const m1 = peakStackMap(3, 7n);
    expect(m1.size).toBeGreaterThan(0);
    expect(m1.has(6n)).toBe(true);
  });
});
