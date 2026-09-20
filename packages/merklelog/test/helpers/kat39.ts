/**
 * KAT-39 fixture: the canonical 39-node MMRIVER/draft-bryce known-answer
 * dataset (go-merklelog `draft_kat39_test.go`), with the published peak
 * hashes at every complete size that the draft tabulates.
 *
 * The node array is DERIVED here from the leaf rule, not transcribed, and two
 * draft-published leaf anchors pin the rule. The peak hashes are the external
 * oracle: tests compare against these values, never against another run of
 * the algorithm under test.
 *
 * Shared by `test/mmr/consistency.test.ts` and
 * `test/mmr/consistent-roots-for-sizes.test.ts`.
 */
import { indexHeight } from "../../src/mmr/proof.js";
import { mmrIndex } from "../../src/mmr/index.js";
import type { Hasher } from "../../src/mmr/types.js";

/** Number of leaves in the canonical 39-node fixture. */
export const KAT39_LEAF_COUNT = 21;

/** Number of MMR nodes in the canonical fixture. */
export const KAT39_NODE_COUNT = 39;

/** Draft-published leaf values that pin the leaf rule `leaf j = H(BE8(mmrIndex(j)))`. */
export const KAT39_ANCHORS: Record<number, string> = {
  0: "af5570f5a1810b7af78caf4bc70a660f0df51e42baf91d4de5b2328de0e83dfc",
  11: "0b5000b73a53f0916c93c68f4b9b6ba8af5a10978634ae4f2237e1f3fbe324fa",
};

/** KAT-39 accumulator peak hashes per complete last-index (draft). */
export const KAT39_PEAK_HASHES: Record<number, string[]> = {
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

/**
 * Complete MMR last-indices covered by KAT39_PEAK_HASHES. The full set of
 * complete indices below 39 is larger; these are the ones the draft tabulates
 * accumulators for, so they are the ones with an external oracle.
 */
export const COMPLETE_LAST_INDICES = [0, 2, 3, 6, 7, 10, 14, 25, 38] as const;

/** Hex string to bytes. */
export const fromHex = (hex: string): Uint8Array =>
  new Uint8Array(hex.match(/../g)!.map((b) => Number.parseInt(b, 16)));

/** Bytes to lowercase hex string. */
export const toHex = (bytes: Uint8Array): string =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

/**
 * Append a leaf to `all`, merging parents per the MMR append rule (interior
 * nodes are H(pos_BE8 || left || right), pos 1-based).
 */
export async function addLeaf(
  hasher: Hasher,
  all: Uint8Array[],
  leaf: Uint8Array,
): Promise<void> {
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

/** KAT-39 leaf rule (MMRIVER draft): leaf j = H(BE8(mmrIndex(j))). */
export async function katLeaf(hasher: Hasher, j: number): Promise<Uint8Array> {
  const be8 = new Uint8Array(8);
  new DataView(be8.buffer).setBigUint64(0, mmrIndex(BigInt(j)));
  hasher.reset();
  hasher.update(be8);
  return hasher.digest();
}

/**
 * Build the 39-node fixture, checking each draft-published anchor leaf as it
 * is produced. Throws if the derived leaf differs from the published value,
 * so a fixture that has drifted cannot silently become the oracle.
 */
export async function buildKat39(hasher: Hasher): Promise<Uint8Array[]> {
  const nodes: Uint8Array[] = [];
  for (let j = 0; j < KAT39_LEAF_COUNT; j++) {
    const leaf = await katLeaf(hasher, j);
    const index = Number(mmrIndex(BigInt(j)));
    const anchor = KAT39_ANCHORS[index];
    if (anchor !== undefined && toHex(leaf) !== anchor) {
      throw new Error(
        `KAT-39 anchor leaf at mmr index ${index}: expected ${anchor}, got ${toHex(leaf)}`,
      );
    }
    await addLeaf(hasher, nodes, leaf);
  }
  if (nodes.length !== KAT39_NODE_COUNT) {
    throw new Error(
      `KAT-39 fixture: expected ${KAT39_NODE_COUNT} nodes, got ${nodes.length}`,
    );
  }
  return nodes;
}

/** The published accumulator for a complete last-index, as bytes. */
export function katPeaks(lastIndex: number): Uint8Array[] {
  return KAT39_PEAK_HASHES[lastIndex].map(fromHex);
}
