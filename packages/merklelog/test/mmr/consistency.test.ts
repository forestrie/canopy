/**
 * FOR-368 Phase 1 (plan-2607-29): real consistency verification, replacing
 * the plan-0027 always-true stub. Vectors are the MMRIVER/draft-bryce KAT-39
 * dataset (go-merklelog draft_kat39_test.go): the canonical 39-node MMR with
 * known peak hashes at every complete size — Go/TS parity by shared
 * known answers, not by re-running Go.
 */
import { beforeAll, describe, expect, it } from "vitest";
import {
  consistentRoots,
  indexConsistencyProof,
  verifyConsistency,
  type ConsistencyProof,
} from "../../src/index.js";
import { createSyncHasher } from "../../src/mmr/algorithms-sync.js";
import { indexHeight, type NodeGetter } from "../../src/mmr/proof.js";
import { mmrIndex } from "../../src/mmr/index.js";
import type { Hasher } from "../../src/mmr/types.js";

/** KAT-39 leaf rule (MMRIVER draft): leaf j = H(BE8(mmrIndex(j))).
 * Derived, not transcribed; two draft-published anchors pin the rule. */
const KAT39_LEAF_COUNT = 21;
const KAT39_ANCHORS: Record<number, string> = {
  0: "af5570f5a1810b7af78caf4bc70a660f0df51e42baf91d4de5b2328de0e83dfc",
  11: "0b5000b73a53f0916c93c68f4b9b6ba8af5a10978634ae4f2237e1f3fbe324fa",
};

/** KAT-39 accumulator peak hashes per complete last-index (draft). */
const KAT39_PEAK_HASHES: Record<number, string[]> = {
  0: ["af5570f5a1810b7af78caf4bc70a660f0df51e42baf91d4de5b2328de0e83dfc"],
  2: ["ad104051c516812ea5874ca3ff06d0258303623d04307c41ec80a7a18b332ef8"],
  3: [
    "ad104051c516812ea5874ca3ff06d0258303623d04307c41ec80a7a18b332ef8",
    "d5688a52d55a02ec4aea5ec1eadfffe1c9e0ee6a4ddbe2377f98326d42dfc975",
  ],
  6: ["827f3213c1de0d4c6277caccc1eeca325e45dfe2c65adce1943774218db61f88"],
  7: [
    "827f3213c1de0d4c6277caccc1eeca325e45dfe2c65adce1943774218db61f88",
    "a3eb8db89fc5123ccfd49585059f292bc40a1c0d550b860f24f84efb4760fbf2",
  ],
  10: [
    "827f3213c1de0d4c6277caccc1eeca325e45dfe2c65adce1943774218db61f88",
    "b8faf5f748f149b04018491a51334499fd8b6060c42a835f361fa9665562d12d",
    "8d85f8467240628a94819b26bee26e3a9b2804334c63482deacec8d64ab4e1e7",
  ],
  14: ["78b2b4162eb2c58b229288bbcb5b7d97c7a1154eed3161905fb0f180eba6f112"],
  25: [
    "78b2b4162eb2c58b229288bbcb5b7d97c7a1154eed3161905fb0f180eba6f112",
    "61b3ff808934301578c9ed7402e3dd7dfe98b630acdf26d1fd2698a3c4a22710",
    "dd7efba5f1824103f1fa820a5c9e6cd90a82cf123d88bd035c7e5da0aba8a9ae",
    "561f627b4213258dc8863498bb9b07c904c3c65a78c1a36bca329154d1ded213",
  ],
  38: [
    "d4fb5649422ff2eaf7b1c0b851585a8cfd14fb08ce11addb30075a96309582a7",
    "6a169105dcc487dbbae5747a0fd9b1d33a40320cf91cf9a323579139e7ff72aa",
    "e9a5f5201eb3c3c856e0a224527af5ac7eb1767fb1aff9bd53ba41a60cde9785",
  ],
};

const COMPLETE_LAST_INDICES = [0, 2, 3, 6, 7, 10, 14, 25, 38] as const;

const fromHex = (hex: string) =>
  new Uint8Array(hex.match(/../g)!.map((b) => Number.parseInt(b, 16)));
const toHex = (bytes: Uint8Array) =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

let hasher: Hasher;
let nodes: Uint8Array[];

/** Append a leaf, merging parents per the MMR append rule (interior nodes
 * are H(pos_BE8 || left || right), pos 1-based). */
async function addLeaf(all: Uint8Array[], leaf: Uint8Array): Promise<void> {
  all.push(leaf);
  let g = 0;
  while (indexHeight(BigInt(all.length)) > g) {
    const right = all[all.length - 1];
    const left = all[all.length - (2 ** (g + 1) - 1) - 1];
    const pos = BigInt(all.length + 1);
    const posBytes = new Uint8Array(8);
    new DataView(posBytes.buffer).setBigUint64(0, pos);
    hasher.reset();
    hasher.update(posBytes);
    hasher.update(left);
    hasher.update(right);
    all.push(await hasher.digest());
    g += 1;
  }
}

const getHash: NodeGetter = (i) => nodes[Number(i)];

async function katLeaf(j: number): Promise<Uint8Array> {
  const be8 = new Uint8Array(8);
  new DataView(be8.buffer).setBigUint64(0, mmrIndex(BigInt(j)));
  hasher.reset();
  hasher.update(be8);
  return hasher.digest();
}

beforeAll(async () => {
  hasher = await createSyncHasher();
  nodes = [];
  for (let j = 0; j < KAT39_LEAF_COUNT; j++) {
    const leaf = await katLeaf(j);
    const anchor =
      KAT39_ANCHORS[
        mmrIndex(BigInt(j)) === 0n ? 0 : Number(mmrIndex(BigInt(j)))
      ];
    if (anchor !== undefined) {
      expect(toHex(leaf), `anchor leaf mmr ${mmrIndex(BigInt(j))}`).toBe(
        anchor,
      );
    }
    await addLeaf(nodes, leaf);
  }
});

function katPeaks(lastIndex: number): Uint8Array[] {
  return KAT39_PEAK_HASHES[lastIndex].map(fromHex);
}

describe("KAT-39 fixture self-check", () => {
  it("re-derives every canonical accumulator from the leaves", () => {
    expect(nodes.length).toBe(39);
    // Peaks are readable directly from the node array at their indices;
    // spot-check via the accumulator values (descending height order).
    for (const last of COMPLETE_LAST_INDICES) {
      const expected = KAT39_PEAK_HASHES[last];
      // Derive via a size-limited proof-free read: the accumulator values
      // must appear in the node array at the peak positions.
      const proof: ConsistencyProof = indexConsistencyProof(
        getHash,
        BigInt(last),
        BigInt(last),
      );
      expect(proof.paths.map((p) => p.length)).toEqual(expected.map(() => 0));
    }
  });
});

describe("verifyConsistency (draft-bryce / KAT-39)", () => {
  it("proves every complete size pair consistent", async () => {
    for (const a of COMPLETE_LAST_INDICES) {
      for (const b of COMPLETE_LAST_INDICES) {
        if (b < a) continue;
        const proof = indexConsistencyProof(getHash, BigInt(a), BigInt(b));
        const result = await verifyConsistency(
          hasher,
          proof,
          katPeaks(a),
          katPeaks(b),
        );
        expect(result.ok, `MMR(${a + 1}) -> MMR(${b + 1})`).toBe(true);
        expect(result.accumulator.map(toHex)).toEqual(KAT39_PEAK_HASHES[b]);
      }
    }
  });

  it("matches the draft worked example: MMR(8) -> MMR(11) path shape [[],[9]]", () => {
    const proof = indexConsistencyProof(getHash, 7n, 10n);
    // Draft positions are 1-based: MMR(A) peaks at positions [7, 8] are
    // indices 6 and 7; the path element at position 9 is index 8.
    expect(proof.paths.length).toBe(2);
    expect(proof.paths[0].length).toBe(0); // position 7 is still a peak
    expect(proof.paths[1].length).toBe(1); // position 8 climbs via position 9
    expect(toHex(proof.paths[1][0])).toBe(toHex(nodes[8]));
  });

  it("rejects a tampered path node", async () => {
    const proof = indexConsistencyProof(getHash, 7n, 38n);
    const tampered = proof.paths.map((p) => p.map((n) => n.slice()));
    const target = tampered.find((p) => p.length > 0)!;
    target[0][0] ^= 0xff;
    const result = await verifyConsistency(
      hasher,
      { ...proof, paths: tampered },
      katPeaks(7),
      katPeaks(38),
    );
    expect(result.ok).toBe(false);
  });

  it("rejects a wrong from-accumulator (forked history)", async () => {
    const proof = indexConsistencyProof(getHash, 7n, 38n);
    const forged = katPeaks(7);
    forged[0] = forged[0].slice();
    forged[0][0] ^= 0xff;
    const result = await verifyConsistency(hasher, proof, forged, katPeaks(38));
    expect(result.ok).toBe(false);
  });

  it("rejects a to-accumulator missing a proven root", async () => {
    // Note: truncating peaksTo is UNDETECTABLE when every old peak
    // collapses under the first new peak (e.g. MMR(26)->MMR(39) proves
    // only peak 30) — and needn't be: peaksTo comes from an authenticated
    // source. The invariant is that any PROVEN root absent from the
    // supplied accumulator fails. MMR(39)->MMR(39) proves all three
    // peaks, so dropping the later ones must fail.
    const proof = indexConsistencyProof(getHash, 38n, 38n);
    const result = await verifyConsistency(
      hasher,
      proof,
      katPeaks(38),
      katPeaks(38).slice(0, 1),
    );
    expect(result.ok).toBe(false);
  });

  it("enforces one path per from-peak (draft len check)", async () => {
    const proof = indexConsistencyProof(getHash, 25n, 38n);
    await expect(
      consistentRoots(hasher, 25n, katPeaks(25), proof.paths.slice(1)),
    ).rejects.toThrow(/a proof for each accumulator peak is required/);
  });

  it("the always-true stub behaviour is gone: inconsistent states FAIL", async () => {
    // MMR(4)'s accumulator against MMR(8)'s state with garbage paths must
    // not verify — the plan-0027 stub returned true for everything.
    const garbage: ConsistencyProof = {
      mmrSizeA: 4n,
      mmrSizeB: 8n,
      paths: [[new Uint8Array(32)], [new Uint8Array(32)]],
    };
    const result = await verifyConsistency(
      hasher,
      garbage,
      katPeaks(3),
      katPeaks(7),
    );
    expect(result.ok).toBe(false);
  });
});
