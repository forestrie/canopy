import { describe, it, expect, beforeAll } from "vitest";
import { calculateRoot, verifyInclusion } from "../../src/mmr/algorithms.js";
import {
  heightIndex,
  leafCount,
  mmrIndexFromLeafIndex,
} from "../../src/mmr/math.js";
import { mmrIndex } from "../../src/mmr/index.js";
import { Uint64 } from "../../src/uint64/index.js";
import type { Proof } from "../../src/mmr/types.js";
import {
  Sha256Hasher,
  hexToBytes,
  bytesToHex,
} from "../helpers/sha256-hasher.js";

/**
 * Known-answer parity tests against the canonical MMR(39) from the MMRIVER
 * draft / go-merklelog `draft_kat39_test.go` (same author as the reference
 * `algorithms.py`). All golden hex below is copied verbatim from that test
 * data — it is NOT derived from the TS implementation under test, so these
 * assertions are non-circular.
 *
 * Source: arbor services/_deps/go-merklelog/mmr/draft_kat39_test.go
 *         and indexheight_test.go / leafcount semantics.
 */

// 21 leaf hashes (SHA-256 of the 8-byte big-endian leaf MMR index).
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

// All 39 node hashes (leaves + interior), node index 0..38.
const KAT39_NODES: string[] = [
  "af5570f5a1810b7af78caf4bc70a660f0df51e42baf91d4de5b2328de0e83dfc",
  "cd2662154e6d76b2b2b92e70c0cac3ccf534f9b74eb5b89819ec509083d00a50",
  "ad104051c516812ea5874ca3ff06d0258303623d04307c41ec80a7a18b332ef8",
  "d5688a52d55a02ec4aea5ec1eadfffe1c9e0ee6a4ddbe2377f98326d42dfc975",
  "8005f02d43fa06e7d0585fb64c961d57e318b27a145c857bcd3a6bdb413ff7fc",
  "9a18d3bc0a7d505ef45f985992270914cc02b44c91ccabba448c546a4b70f0f0",
  "827f3213c1de0d4c6277caccc1eeca325e45dfe2c65adce1943774218db61f88",
  "a3eb8db89fc5123ccfd49585059f292bc40a1c0d550b860f24f84efb4760fbf2",
  "4c0e071832d527694adea57b50dd7b2164c2a47c02940dcf26fa07c44d6d222a",
  "b8faf5f748f149b04018491a51334499fd8b6060c42a835f361fa9665562d12d",
  "8d85f8467240628a94819b26bee26e3a9b2804334c63482deacec8d64ab4e1e7",
  "0b5000b73a53f0916c93c68f4b9b6ba8af5a10978634ae4f2237e1f3fbe324fa",
  "6f3360ad3e99ab4ba39f2cbaf13da56ead8c9e697b03b901532ced50f7030fea",
  "508326f17c5f2769338cb00105faba3bf7862ca1e5c9f63ba2287e1f3cf2807a",
  "78b2b4162eb2c58b229288bbcb5b7d97c7a1154eed3161905fb0f180eba6f112",
  "e66c57014a6156061ae669809ec5d735e484e8fcfd540e110c9b04f84c0b4504",
  "998e907bfbb34f71c66b6dc6c40fe98ca6d2d5a29755bc5a04824c36082a61d1",
  "f4a0db79de0fee128fbe95ecf3509646203909dc447ae911aa29416bf6fcba21",
  "5bc67471c189d78c76461dcab6141a733bdab3799d1d69e0c419119c92e82b3d",
  "1b8d0103e3a8d9ce8bda3bff71225be4b5bb18830466ae94f517321b7ecc6f94",
  "0a4d7e66c92de549b765d9e2191027ff2a4ea8a7bd3eb04b0ed8ee063bad1f70",
  "61b3ff808934301578c9ed7402e3dd7dfe98b630acdf26d1fd2698a3c4a22710",
  "7a42e3892368f826928202014a6ca95a3d8d846df25088da80018663edf96b1c",
  "aed2b8245fdc8acc45eda51abc7d07e612c25f05cadd1579f3474f0bf1f6bdc6",
  "dd7efba5f1824103f1fa820a5c9e6cd90a82cf123d88bd035c7e5da0aba8a9ae",
  "561f627b4213258dc8863498bb9b07c904c3c65a78c1a36bca329154d1ded213",
  "1209fe3bc3497e47376dfbd9df0600a17c63384c85f859671956d8289e5a0be8",
  "6b4a3bd095c63d1dffae1ac03eb8264fdce7d51d2ac26ad0ebf9847f5b9be230",
  "4459f4d6c764dbaa6ebad24b0a3df644d84c3527c961c64aab2e39c58e027eb1",
  "77651b3eec6774e62545ae04900c39a32841e2b4bac80e2ba93755115252aae1",
  "d4fb5649422ff2eaf7b1c0b851585a8cfd14fb08ce11addb30075a96309582a7",
  "1664a6e0ea12d234b4911d011800bb0f8c1101a0f9a49a91ee6e2493e34d8e7b",
  "707d56f1f282aee234577e650bea2e7b18bb6131a499582be18876aba99d4b60",
  "0c9f36783b5929d43c97fe4b170d12137e6950ef1b3a8bd254b15bbacbfdee7f",
  "4d75f61869104baa4ccff5be73311be9bdd6cc31779301dfc699479403c8a786",
  "0764c726a72f8e1d245f332a1d022fffdada0c4cb2a016886e4b33b66cb9a53f",
  "c861552e9e17c41447d375c37928f9fa5d387d1e8470678107781c20a97ebc8f",
  "6a169105dcc487dbbae5747a0fd9b1d33a40320cf91cf9a323579139e7ff72aa",
  "e9a5f5201eb3c3c856e0a224527af5ac7eb1767fb1aff9bd53ba41a60cde9785",
];

// MMR index of each leaf (KAT39LeafMMRIndices).
const KAT39_LEAF_MMR_INDICES: bigint[] = [
  0n,
  1n,
  3n,
  4n,
  7n,
  8n,
  10n,
  11n,
  15n,
  16n,
  18n,
  19n,
  22n,
  23n,
  25n,
  26n,
  31n,
  32n,
  34n,
  35n,
  38n,
];

// Complete (valid) MMR sizes for 1..21 leaves (KAT39CompleteMMRSizes).
const KAT39_COMPLETE_MMR_SIZES: bigint[] = [
  1n,
  3n,
  4n,
  7n,
  8n,
  10n,
  11n,
  15n,
  16n,
  18n,
  19n,
  22n,
  23n,
  25n,
  26n,
  31n,
  32n,
  34n,
  35n,
  38n,
  39n,
];

// Height index per node (0..38), derived from the canonical tree structure.
const KAT39_NODE_HEIGHTS: number[] = (() => {
  const h = new Array<number>(39).fill(0);
  for (const i of [2, 5, 9, 12, 17, 20, 24, 27, 33, 36]) h[i] = 1;
  for (const i of [6, 13, 21, 28, 37]) h[i] = 2;
  for (const i of [14, 29]) h[i] = 3;
  h[30] = 4;
  return h;
})();

// Peaks of the full MMR(39): node indices 30, 37, 38 (KAT39PeakIndices[38]).
const KAT39_FULL_PEAKS: number[] = [30, 37, 38];
const MMR39_LAST_INDEX = 38n;

/**
 * Faithful port of go-merklelog `AddHashedLeaf`: append leaf, then backfill
 * interior nodes as H(pos_BE8 || left || right). Independent of calculateRoot.
 */
async function buildNodeTable(leafHashes: Uint8Array[]): Promise<Uint8Array[]> {
  const nodes: Uint8Array[] = [];
  const hasher = new Sha256Hasher();
  for (const leaf of leafHashes) {
    nodes.push(leaf);
    let i = BigInt(nodes.length); // next index (1-based count)
    let height = 0;
    // i points at the "next" position; backfill while it would be higher.
    while (heightIndex(new Uint64(i)) > height) {
      const iLeft = i - (2n << BigInt(height));
      const iRight = i - 1n;
      hasher.reset();
      hasher.update(u64be(i + 1n)); // parent 1-based position
      hasher.update(nodes[Number(iLeft)]!);
      hasher.update(nodes[Number(iRight)]!);
      nodes.push(await hasher.digest());
      i = BigInt(nodes.length);
      height += 1;
    }
  }
  return nodes;
}

/** Faithful port of go-merklelog `InclusionProof` reading from `nodes`. */
function inclusionProof(
  nodes: Uint8Array[],
  mmrLastIndex: bigint,
  start: bigint,
): Uint8Array[] {
  if (start > mmrLastIndex) throw new Error("index out of range");
  let i = start;
  let g = heightIndex(new Uint64(i));
  const proof: Uint8Array[] = [];
  for (;;) {
    const siblingOffset = 2n << BigInt(g);
    let iSibling: bigint;
    if (heightIndex(new Uint64(i + 1n)) > g) {
      iSibling = i - siblingOffset + 1n;
      i += 1n;
    } else {
      iSibling = i + siblingOffset - 1n;
      i += siblingOffset;
    }
    if (iSibling > mmrLastIndex) return proof;
    proof.push(nodes[Number(iSibling)]!);
    g += 1;
  }
}

function u64be(value: bigint): Uint8Array {
  const out = new Uint8Array(8);
  let v = value & 0xffffffffffffffffn;
  for (let i = 7; i >= 0; i--) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}

/** Node index of the accumulator peak that commits node `i` in MMR(39). */
function coveringPeak(i: bigint): number {
  if (i <= 30n) return 30;
  if (i <= 37n) return 37;
  return 38;
}

describe("MMR(39) KAT parity (go-merklelog draft_kat39)", () => {
  let nodes: Uint8Array[];

  beforeAll(async () => {
    nodes = await buildNodeTable(KAT39_LEAVES.map(hexToBytes));
  });

  it("add_leaf_hash reproduces the full 39-node hash table", () => {
    expect(nodes.length).toBe(KAT39_NODES.length);
    expect(nodes.map(bytesToHex)).toEqual(KAT39_NODES);
  });

  it("leaves land at their expected MMR indices", () => {
    for (let e = 0; e < KAT39_LEAVES.length; e++) {
      const idx = Number(KAT39_LEAF_MMR_INDICES[e]!);
      expect(bytesToHex(nodes[idx]!)).toBe(KAT39_LEAVES[e]);
    }
  });

  it("index_height matches the canonical heights for all 39 nodes", () => {
    for (let i = 0; i < 39; i++) {
      expect(heightIndex(new Uint64(BigInt(i)))).toBe(KAT39_NODE_HEIGHTS[i]);
    }
  });

  it("index_height matches go TestIndexHeight spot cases", () => {
    const cases: Array<[bigint, number]> = [
      [0n, 0],
      [1n, 0],
      [3n, 0],
      [4n, 0],
      [9n, 1],
      [11n, 0],
      [12n, 1],
      [13n, 2],
      [21n, 2],
    ];
    for (const [i, want] of cases) {
      expect(heightIndex(new Uint64(i))).toBe(want);
    }
  });

  it("mmr_index(leafIndex) matches KAT39 leaf MMR indices", () => {
    for (let e = 0; e < KAT39_LEAF_MMR_INDICES.length; e++) {
      expect(mmrIndex(BigInt(e))).toBe(KAT39_LEAF_MMR_INDICES[e]);
      expect(mmrIndexFromLeafIndex(new Uint64(BigInt(e))).toBigInt()).toBe(
        KAT39_LEAF_MMR_INDICES[e],
      );
    }
  });

  it("leaf_count(mmrSize) matches the complete-MMR sizes", () => {
    for (let k = 0; k < KAT39_COMPLETE_MMR_SIZES.length; k++) {
      const size = KAT39_COMPLETE_MMR_SIZES[k]!;
      expect(leafCount(new Uint64(size)).toBigInt()).toBe(BigInt(k + 1));
    }
  });

  it("the full MMR(39) accumulator peaks match KAT39 peak hashes", () => {
    expect(KAT39_FULL_PEAKS.map((i) => bytesToHex(nodes[i]!))).toEqual(
      KAT39_FULL_PEAKS.map((i) => KAT39_NODES[i]),
    );
  });

  it("calculateRoot + verifyInclusion reproduce the covering peak for every node", async () => {
    const hasher = new Sha256Hasher();
    for (let n = 0n; n <= MMR39_LAST_INDEX; n++) {
      const path = inclusionProof(nodes, MMR39_LAST_INDEX, n);
      const proof: Proof = { path, mmrIndex: n };
      const root = await calculateRoot(hasher, nodes[Number(n)]!, proof, n);
      const expectedPeakHex = KAT39_NODES[coveringPeak(n)]!;
      expect(bytesToHex(root)).toBe(expectedPeakHex);
      expect(
        await verifyInclusion(hasher, nodes[Number(n)]!, proof, root),
      ).toBe(true);
    }
  });

  it("verifyInclusion rejects a tampered peak (leaf 0)", async () => {
    const hasher = new Sha256Hasher();
    const path = inclusionProof(nodes, MMR39_LAST_INDEX, 0n);
    const proof: Proof = { path, mmrIndex: 0n };
    const wrong = hexToBytes(KAT39_NODES[30]!);
    wrong[0] ^= 0xff;
    expect(await verifyInclusion(hasher, nodes[0]!, proof, wrong)).toBe(false);
  });
});
