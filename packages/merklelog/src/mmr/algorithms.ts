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
import { inclusionProof, peakMMRIndexes, type NodeGetter } from "./proof.js";
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
 * Verify MMR(A) is a committed prefix of MMR(B)
 * (draft-bryce "Verifying the Receipt of consistency";
 * go-merklelog `VerifyConsistency`).
 *
 * Replaces the plan-0027 always-true stub (FOR-368 Phase 1,
 * plan-2607-29): the previous signature took two inclusion proofs and
 * returned true unconditionally; no caller existed.
 *
 * @param proof - consistency proof `mmrSizeA -> mmrSizeB`
 * @param peaksFrom - TRUSTED MMR(A) accumulator (e.g. a signed checkpoint
 *   payload), descending height order
 * @param peaksTo - MMR(B) accumulator to prove against (e.g. an anchored
 *   on-chain state), descending height order
 * @returns ok, with the MMR(B) accumulator on success
 */
export async function verifyConsistency(
  hasher: Hasher,
  proof: ConsistencyProof,
  peaksFrom: Uint8Array[],
  peaksTo: Uint8Array[],
): Promise<{ ok: boolean; accumulator: Uint8Array[] }> {
  const proven = await consistentRoots(
    hasher,
    proof.mmrSizeA - 1n,
    peaksFrom,
    proof.paths,
  );
  // Both lists are in descending height order, so every proven root must
  // appear in order within peaksTo (a linear scan; go-merklelog semantics:
  // a proven root matches the current peak or exactly the next one down).
  let ito = 0;
  for (const root of proven) {
    if (ito < peaksTo.length && arraysEqual(peaksTo[ito], root)) {
      continue;
    }
    ito += 1;
    if (ito >= peaksTo.length || !arraysEqual(peaksTo[ito], root)) {
      return { ok: false, accumulator: [] };
    }
  }
  // The full MMR(B) accumulator is the proven prefix plus any right-peaks;
  // returning peaksTo is safe because consistentRoots enforced one proof
  // per MMR(A) peak (see go-merklelog VerifyConsistency).
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
