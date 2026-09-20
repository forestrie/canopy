/**
 * MMR Algorithm Implementations
 *
 * Core algorithms for Merkle Mountain Range operations including
 * peak bagging, inclusion proofs, and consistency proofs.
 *
 * This implementation is based on the authoritative Python reference:
 * https://raw.githubusercontent.com/robinbryce/merkle-mountain-range-proofs/refs/heads/main/algorithms.py
 *
 * And the associated IETF draft specification:
 * https://raw.githubusercontent.com/robinbryce/draft-bryce-cose-receipts-mmr-profile/refs/heads/main/draft-bryce-cose-receipts-mmr-profile.md
 */

import type { Proof, Hasher } from "./types.js";
import {
  inclusionProof,
  peakMMRIndexes,
  bitLength,
  popcount,
  peaksBitmap,
  mmrSizeForLeafCount,
  type NodeGetter,
} from "./proof.js";
import {
  ConsistencyPathLengthMismatch,
  ConsistencyPeakCountMismatch,
  ConsistencyRootMismatch,
  IncompleteTreeSize,
  SizeMustIncrease,
} from "./errors.js";
import { Uint64 } from "../uint64/index.js";
import { heightIndex } from "./math.js";
import { arraysEqual } from "../utils/arrays.js";

/**
 * Encodes a Uint64 as 8 bytes big-endian.
 *
 * Mirrors go-merklelog `HashWriteUint64` and the reference
 * `pos.to_bytes(8, byteorder="big")` used by `hash_pospair64`.
 */
function u64BigEndian(value: Uint64): Uint8Array {
  const out = new Uint8Array(8);
  let v = value.toBigInt() & 0xffffffffffffffffn;
  for (let i = 7; i >= 0; i--) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}

/**
 * Bags peaks together to compute a single root hash.
 *
 * The root is defined as the 'bagging' of all peaks, starting with the highest.
 * This creates a binary merkle tree from the peaks to obtain a single tree root.
 *
 * WARNING — NOT used by the receipt verification path, and NOT spec-aligned for
 * MMRIVER receipts. The MMR profile
 * (draft-bryce-cose-receipts-mmr-profile) proves inclusion to a single peak
 * (the accumulator is the list of peaks); it does not bag peaks. This helper
 * also hashes `H(right || left)` WITHOUT the 1-based position prefix that
 * `calculateRoot` commits, so it is inconsistent with go-merklelog interior
 * hashing. Retained only for any legacy bagging caller; do not introduce new
 * consumers without first reconciling with the spec.
 *
 * @param hasher - Cryptographic hasher instance
 * @param peaks - Array of peak hashes (highest to lowest)
 * @returns The bagged root hash
 */
export async function bagPeaks(
  hasher: Hasher,
  peaks: Uint8Array[],
): Promise<Uint8Array> {
  if (peaks.length === 0) {
    throw new Error("Cannot bag empty peaks array");
  }

  if (peaks.length === 1) {
    return peaks[0];
  }

  const peakHashes = [...peaks];

  while (peakHashes.length > 1) {
    const right = peakHashes.pop()!;
    const left = peakHashes.pop()!;

    hasher.reset();
    hasher.update(right);
    hasher.update(left);
    const combined = await hasher.digest();

    peakHashes.push(combined);
  }

  return peakHashes[0];
}

/**
 * Calculates the root hash from a leaf hash and inclusion proof
 *
 * Mirrors the reference `included_root` (algorithms.py): each interior node is
 * `H(pos_BE8 || left || right)` where `pos` is the 1-based node position.
 *
 * @param hasher - Cryptographic hasher instance
 * @param leafHash - Hash of the leaf being proven
 * @param proof - Inclusion proof path
 * @param leafIndex - The zero-based MMR index of the node being proven. Despite
 *   the name, this is treated as an MMR index (it seeds `currentPos = index + 1`
 *   and `heightIndex(index)`). For leaf 0 the leaf index and MMR index coincide;
 *   for any other leaf, callers MUST pass the MMR index (see `proof.mmrIndex`),
 *   not the leaf index.
 * @returns The calculated root hash
 */
export async function calculateRoot(
  hasher: Hasher,
  leafHash: Uint8Array,
  proof: Proof,
  leafIndex: bigint,
): Promise<Uint8Array> {
  let currentHash = leafHash;
  const mmrIndex = new Uint64(leafIndex);
  let currentHeight = heightIndex(mmrIndex);
  let currentPos = mmrIndex.add(new Uint64(1));

  for (const siblingHash of proof.path) {
    hasher.reset();

    const nextHeight = heightIndex(new Uint64(currentPos.toBigInt()));
    const isRightChild = nextHeight > currentHeight;

    // Advance currentPos to the parent node's 1-based position, then commit it
    // as the hash prefix: interior nodes are H(pos || left || right) per the
    // MMR profile (draft-bryce-cose-receipts-mmr-profile `included_root` /
    // `hash_pospair64`, and go-merklelog `HashPosPair64`). Omitting `pos`
    // produces the wrong peak for any leaf above a single-leaf tree.
    if (isRightChild) {
      currentPos = currentPos.add(new Uint64(1));
      hasher.update(u64BigEndian(currentPos));
      hasher.update(siblingHash);
      hasher.update(currentHash);
    } else {
      currentPos = currentPos.add(new Uint64(2).shl(currentHeight));
      hasher.update(u64BigEndian(currentPos));
      hasher.update(currentHash);
      hasher.update(siblingHash);
    }

    currentHash = await hasher.digest();
    currentHeight += 1;
  }

  return currentHash;
}

/**
 * Verifies an inclusion proof
 *
 * @param hasher - Cryptographic hasher instance
 * @param leafHash - Hash of the leaf being proven
 * @param proof - Inclusion proof
 * @param root - Expected root hash
 * @returns True if the proof is valid
 */
export async function verifyInclusion(
  hasher: Hasher,
  leafHash: Uint8Array,
  proof: Proof,
  root: Uint8Array,
): Promise<boolean> {
  if (proof.leafIndex === undefined && proof.mmrIndex === undefined) {
    throw new Error("Proof must have either leafIndex or mmrIndex");
  }

  const leafIdx =
    proof.leafIndex !== undefined ? proof.leafIndex : proof.mmrIndex!;
  const calculatedRoot = await calculateRoot(hasher, leafHash, proof, leafIdx);

  return arraysEqual(calculatedRoot, root);
}

/**
 * Consistency proof between two MMR states (draft-bryce `consistency-proof`,
 * go-merklelog `ConsistencyProof`): one inclusion path per MMR(A) peak,
 * proven in MMR(B). Verified against trusted accumulators for both sizes.
 */
export interface ConsistencyProof {
  mmrSizeA: bigint;
  mmrSizeB: bigint;
  /** One sibling path per MMR(A) peak (ascending), in peak order. */
  paths: Uint8Array[][];
}

/**
 * Recover the MMR(B) accumulator prefix committed by the MMR(A) peaks
 * (draft-bryce `consistent_roots`; go-merklelog `ConsistentRoots`).
 *
 * Each MMR(A) peak is an interior node of MMR(B) at an immovable position;
 * its inclusion path climbs to the covering MMR(B) peak. Consecutive
 * duplicate roots collapse (many old peaks share one new peak). Requires
 * one path per MMR(A) peak (draft: `len(peaks(ifrom)) == len(accumulatorfrom)`).
 *
 * This fold does not enforce the proof shape the two sizes imply: it reads
 * whatever path lengths it is given and collapses whatever roots coincide.
 * Use {@link consistentRootsForSizes} for verification — it checks each path
 * against the length MMR(A) -> MMR(B) fixes and requires the paths under one
 * target peak to agree.
 *
 * @param ifrom - last node index of the complete MMR(A) (`mmrSizeA - 1`)
 * @param accumulatorFrom - MMR(A) peak values, descending height order
 * @param paths - inclusion path per peak, proven in MMR(B)
 */
export async function consistentRoots(
  hasher: Hasher,
  ifrom: bigint,
  accumulatorFrom: Uint8Array[],
  paths: Uint8Array[][],
): Promise<Uint8Array[]> {
  const fromPeaks = peakMMRIndexes(ifrom);
  if (fromPeaks.length !== paths.length) {
    throw new Error(
      `a proof for each accumulator peak is required: ${fromPeaks.length} peaks, ${paths.length} paths`,
    );
  }
  if (accumulatorFrom.length !== fromPeaks.length) {
    throw new Error(
      `accumulator length mismatch: ${accumulatorFrom.length} values for ${fromPeaks.length} peaks`,
    );
  }
  const roots: Uint8Array[] = [];
  for (let i = 0; i < accumulatorFrom.length; i++) {
    const root = await calculateRoot(
      hasher,
      accumulatorFrom[i],
      { path: paths[i], mmrIndex: fromPeaks[i] },
      fromPeaks[i],
    );
    if (roots.length > 0 && arraysEqual(roots[roots.length - 1], root)) {
      continue;
    }
    roots.push(root);
  }
  return roots;
}

/**
 * Produce the peaks of MMR(sizeTo) that `paths` prove from the peaks of
 * MMR(sizeFrom), requiring the paths to have exactly the shape the two sizes
 * imply (draft-bryce-cose-receipts-mmr-profile, "Verifying the Receipt of
 * consistency", with the draft's SHOULD on path lengths enforced in the same
 * pass). Line-for-line port of the reference `consistent_roots_for_sizes`
 * (algorithms.py) and of Solidity `consistentRootsForSizes`
 * (univocity `src/algorithms/consistentRoots.sol`).
 *
 * Sizes are node counts (the MMR ending at index `i` has `i + 1` nodes).
 * `sizeFrom` MUST be the size of the state the verifier already trusts; taken
 * from the proof instead, the check is void. Only `sizeTo` is required to be
 * a complete MMR size: every trusted size was itself a checked target.
 *
 * For a complete MMR the set bits of `peaksBitmap(size)` are the peak heights,
 * high to low, which is accumulator order. Let `split` be the highest bit on
 * which the two bitmaps differ; as `sizeTo > sizeFrom` the target has it and
 * the origin does not. An origin peak above `split` is also a peak of the
 * target: its path is empty and it is returned unchanged. Every origin peak
 * below `split` is committed by the target peak of height `split`: its path
 * has length `split - h`, and every such path must prove the same root. The
 * target's remaining peaks lie below every origin peak, so no path reaches
 * them; the prover supplies them separately and their count is returned.
 *
 * Because the shape is fixed by the sizes alone, no peak index list and no
 * per-hop bookkeeping beyond the hash itself is needed: the bitmaps are
 * iterated directly.
 *
 * @param hasher - cryptographic hasher instance
 * @param sizeFrom - node count of the trusted origin state (0 for an empty log)
 * @param sizeTo - node count of the target state; must exceed `sizeFrom` and
 *   must be a complete MMR size
 * @param accumulatorFrom - peaks of MMR(sizeFrom), descending height order
 * @param paths - one path per origin peak, in the same order
 * @returns `roots`, the peaks of MMR(sizeTo) proven from the origin peaks in
 *   descending height order (the unchanged peaks, then the one proven root if
 *   any), and `expectedRight`, the number of MMR(sizeTo) peaks the prover must
 *   supply as right peaks. `roots` followed by those right peaks is the
 *   accumulator of MMR(sizeTo).
 * @throws {SizeMustIncrease} if `sizeTo <= sizeFrom`
 * @throws {IncompleteTreeSize} if `sizeTo` is not a complete MMR size
 * @throws {ConsistencyPeakCountMismatch} if `accumulatorFrom` or `paths` does
 *   not have one entry per origin peak
 * @throws {ConsistencyPathLengthMismatch} if a path length differs from the
 *   length the two sizes imply
 * @throws {ConsistencyRootMismatch} if two paths under one target peak produce
 *   different roots
 */
export async function consistentRootsForSizes(
  hasher: Hasher,
  sizeFrom: bigint,
  sizeTo: bigint,
  accumulatorFrom: Uint8Array[],
  paths: Uint8Array[][],
): Promise<{ roots: Uint8Array[]; expectedRight: number }> {
  if (sizeTo <= sizeFrom) {
    throw new SizeMustIncrease(sizeFrom, sizeTo);
  }
  const to = peaksBitmap(sizeTo);
  // peaksBitmap rounds an incomplete size down to the largest MMR below it,
  // so `to` describes MMR(sizeTo) only if sizeTo is complete. Without this a
  // target such as 6 anchors an accumulator that is no MMR's, and a verifier
  // later reads its entries at the wrong heights.
  if (mmrSizeForLeafCount(to) !== sizeTo) {
    throw new IncompleteTreeSize(sizeTo);
  }
  const from = peaksBitmap(sizeFrom);
  const n = popcount(from);
  if (accumulatorFrom.length !== n) {
    throw new ConsistencyPeakCountMismatch(n, accumulatorFrom.length);
  }
  if (paths.length !== n) {
    throw new ConsistencyPeakCountMismatch(n, paths.length);
  }
  const nto = popcount(to);
  if (n === 0) {
    return { roots: [], expectedRight: nto };
  }

  const split = bitLength(from ^ to) - 1;
  const roots: Uint8Array[] = [];
  // Nodes preceding the current origin peak's subtree; a peak of height h
  // sits at offset + 2^(h+1) - 2 and its subtree has 2^(h+1) - 1 nodes.
  let offset = 0n;
  let i = 0;

  // Origin peaks above the split are also peaks of the target. The path is
  // not read; requiring it to be empty rejects unused material (a shape
  // check: the result does not depend on it).
  for (let h = bitLength(from) - 1; h > split; h--) {
    if (((from >> BigInt(h)) & 1n) === 0n) continue;
    if (paths[i].length !== 0) {
      throw new ConsistencyPathLengthMismatch(i, 0, paths[i].length);
    }
    roots.push(accumulatorFrom[i]);
    offset += (1n << BigInt(h + 1)) - 1n;
    i += 1;
  }

  // Origin peaks below the split are all committed by the target peak of
  // height `split` (bit `split` itself is clear in `from`), so each path must
  // have length split - h and every path must prove the same root. The first
  // `above` peaks were returned unchanged, so i === above at the first peak
  // below the split.
  const above = roots.length;
  let root: Uint8Array | undefined;
  for (let h = split - 1; h >= 0; h--) {
    if (((from >> BigInt(h)) & 1n) === 0n) continue;
    const expected = split - h;
    if (paths[i].length !== expected) {
      throw new ConsistencyPathLengthMismatch(i, expected, paths[i].length);
    }
    const subtree = (1n << BigInt(h + 1)) - 1n;
    const peakMMRIndex = offset + subtree - 1n;
    const proven = await calculateRoot(
      hasher,
      accumulatorFrom[i],
      { path: paths[i], mmrIndex: peakMMRIndex },
      peakMMRIndex,
    );
    if (i === above) {
      root = proven;
    } else if (!arraysEqual(proven, root as Uint8Array)) {
      throw new ConsistencyRootMismatch(i);
    }
    offset += subtree;
    i += 1;
  }
  if (n > above) {
    roots.push(root as Uint8Array);
  }

  return { roots, expectedRight: nto - roots.length };
}

/**
 * Verify MMR(A) is a committed prefix of MMR(B)
 * (draft-bryce "Verifying the Receipt of consistency";
 * go-merklelog `VerifyConsistency`).
 *
 * BOTH sizes are CALLER-SUPPLIED trusted state (ADR-0066 D5.4), never read
 * off the proof: `sizeFrom` is the size of the state `peaksFrom` is the
 * accumulator of, and `sizeTo` the size `peaksTo` is claimed to be the
 * accumulator of. The proof contributes only `paths`. Taking either size
 * from the proof makes the check void: the fold constrains a declared
 * `sizeFrom` by the origin peak COUNT alone, which a whole family of sizes
 * share, so one set of paths and peaks verified at many size pairs — with
 * the draft's own MMR(11) -> MMR(39) material, 24 distinct pairs, of which
 * one is the true relation. `indexConsistencyProof` still returns the
 * {@link ConsistencyProof} wire type with its declared sizes; a caller that
 * relays that type passes `proof.paths` here and supplies the sizes it
 * trusts, comparing the declared sizes with them separately if it wants to
 * report a disagreement.
 *
 * Routed through {@link consistentRootsForSizes}, so the proof must have the
 * shape `sizeFrom -> sizeTo` implies: one path per MMR(A) peak, empty above
 * the split and of length `split - h` below it, with every path below the
 * split proving the same root. The proven roots must then be the leading
 * entries of `peaksTo`, and `peaksTo` must hold exactly those plus the
 * `expectedRight` right peaks no path reaches — so a truncated or padded
 * target accumulator is rejected on its length alone.
 *
 * Replaces the plan-0027 always-true stub (FOR-368 Phase 1,
 * plan-2607-29): the previous signature took two inclusion proofs and
 * returned true unconditionally; no caller existed.
 *
 * @param sizeFrom - TRUSTED node count of MMR(A)
 * @param sizeTo - TRUSTED node count of MMR(B)
 * @param peaksFrom - TRUSTED MMR(A) accumulator (e.g. a signed checkpoint
 *   payload), descending height order
 * @param paths - one inclusion path per MMR(A) peak, in the same order
 * @param peaksTo - MMR(B) accumulator to prove against (e.g. an anchored
 *   on-chain state), descending height order
 * @returns ok, with the MMR(B) accumulator on success. A value that does not
 *   match `peaksTo` returns `{ok: false, accumulator: []}`; a proof that does
 *   not have the shape the sizes imply throws one of the typed errors in
 *   `./errors.js` (all `ConsistencyShapeError` subclasses), which callers
 *   report as a malformed proof rather than a failed comparison.
 */
export async function verifyConsistency(
  hasher: Hasher,
  sizeFrom: bigint,
  sizeTo: bigint,
  peaksFrom: Uint8Array[],
  paths: Uint8Array[][],
  peaksTo: Uint8Array[],
): Promise<{ ok: boolean; accumulator: Uint8Array[] }> {
  const { roots, expectedRight } = await consistentRootsForSizes(
    hasher,
    sizeFrom,
    sizeTo,
    peaksFrom,
    paths,
  );
  // roots is the leading run of the MMR(B) accumulator and expectedRight
  // counts the peaks below every MMR(A) peak, which no path reaches. Together
  // they fix the length of MMR(B)'s accumulator, so the supplied peaksTo must
  // have that length and must start with the proven roots.
  if (peaksTo.length !== roots.length + expectedRight) {
    return { ok: false, accumulator: [] };
  }
  for (let i = 0; i < roots.length; i++) {
    if (!arraysEqual(peaksTo[i], roots[i])) {
      return { ok: false, accumulator: [] };
    }
  }
  return { ok: true, accumulator: peaksTo };
}

/**
 * Generate a consistency proof `mmrIndexA -> mmrIndexB` from node data
 * (go-merklelog `IndexConsistencyProof`): an inclusion path in MMR(B) for
 * each MMR(A) peak. Node access is by MMR index (massif tiles or any
 * replicated store).
 */
export function indexConsistencyProof(
  get: NodeGetter,
  mmrIndexA: bigint,
  mmrIndexB: bigint,
): ConsistencyProof {
  const paths: Uint8Array[][] = [];
  for (const peak of peakMMRIndexes(mmrIndexA)) {
    paths.push(inclusionProof(get, mmrIndexB, peak));
  }
  return { mmrSizeA: mmrIndexA + 1n, mmrSizeB: mmrIndexB + 1n, paths };
}
