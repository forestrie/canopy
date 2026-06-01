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
 * Verifies a consistency proof between two MMR states.
 *
 * WARNING — NOT IMPLEMENTED. This is a stub: it compares each root against
 * itself and therefore ALWAYS returns true. It performs no real consistency
 * check and MUST NOT be relied upon for security. No worker path currently
 * calls it. See the reference `verify_consistency` (algorithms.py) for the
 * intended algorithm (verify proof2 extends proof1 via position-committed
 * interior hashing).
 *
 * @param hasher - Cryptographic hasher instance
 * @param proof1 - Proof for the first state
 * @param proof2 - Proof for the second state
 * @param root1 - Root hash of the first state
 * @param root2 - Root hash of the second state
 * @returns Always true (stub) — do not use for verification
 */
export function verifyConsistency(
  hasher: Hasher,
  proof1: Proof,
  proof2: Proof,
  root1: Uint8Array,
  root2: Uint8Array,
): boolean {
  // TODO(plan-0027): Implement full consistency check (verify proof2 extends
  // proof1) with position-committed interior hashing. Until then this returns
  // true unconditionally and must not be used for any trust decision.
  return arraysEqual(root1, root1) && arraysEqual(root2, root2);
}
