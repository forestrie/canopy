import { Uint64 } from "../uint64/index.js";

/**
 * MMR Math Functions
 *
 * Core mathematical functions for Merkle Mountain Range operations.
 * Uses Uint64 wrapper for all arithmetic to ensure correctness.
 */

/**
 * Returns the zero-based height index (g) of an MMR index
 *
 * The height index of a leaf is 0.
 * Translated from go-merklelog/mmr/indexheight.go IndexHeight
 */
export function heightIndex(mmrIndex: Uint64): number {
  // Convert from zero-based index to 1-based position
  const pos = mmrIndex.add(new Uint64(1));
  return posHeight(pos);
}

/**
 * Returns the one-based height (h) of an MMR index
 *
 * h = g + 1 where g is the height index
 */
export function height(mmrIndex: Uint64): number {
  return heightIndex(mmrIndex) + 1;
}

/**
 * PosHeight - obtains height from a 1-based position
 *
 * Translated from go-merklelog/mmr/indexheight.go PosHeight
 */
function posHeight(pos: Uint64): number {
  let current = pos;
  while (!allOnes(current)) {
    current = jumpLeftPerfect(current);
  }
  return bitLength(current) - 1;
}

/**
 * JumpLeftPerfect - jumps left to the leftmost node at the same height
 *
 * Translated from go-merklelog/mmr/indexheight.go JumpLeftPerfect
 */
function jumpLeftPerfect(pos: Uint64): Uint64 {
  const bitLen = bitLength(pos);
  const mostSignificantBit = new Uint64(1).shl(bitLen - 1);
  return pos.sub(mostSignificantBit.sub(new Uint64(1)));
}

/**
 * Checks if a value has all bits set (all ones in binary)
 */
function allOnes(value: Uint64): boolean {
  // A value has all ones if value + 1 is a power of 2
  const next = value.add(new Uint64(1));
  const bitLen = bitLength(next);
  const powerOf2 = new Uint64(1).shl(bitLen - 1);
  return next.equals(powerOf2);
}

/**
 * Returns the number of bits needed to represent the value
 */
function bitLength(value: Uint64): number {
  const bigInt = value.toBigInt();
  if (bigInt === 0n) {
    return 0;
  }
  return bigInt.toString(2).length;
}

/**
 * Converts leaf index to MMR index
 *
 * @param leafIndex - Zero-based leaf index
 * @returns MMR index
 */
export function mmrIndexFromLeafIndex(leafIndex: Uint64): Uint64 {
  // Use the mmrIndex function from index.ts
  // Import it dynamically to avoid circular dependency
  return new Uint64(mmrIndexFromLeafIndexInternal(leafIndex.toBigInt()));
}

// Internal helper that matches the implementation in index.ts
function mmrIndexFromLeafIndexInternal(leafIndex: bigint): bigint {
  let sum = 0n;
  let current = leafIndex;

  while (current > 0n) {
    const h = BigInt(current.toString(2).length);
    sum += (1n << h) - 1n;
    const half = 1n << (h - 1n);
    current -= half;
  }

  return sum;
}

/**
 * Converts MMR index to leaf index
 *
 * @param mmrIndex - MMR index
 * @returns Leaf index
 */
export function leafIndex(mmrIndex: Uint64): Uint64 {
  // This needs to be implemented based on the MMR structure
  // For now, we'll use an iterative approach
  let current = mmrIndex;
  let leafCount = new Uint64(0);

  while (current.toBigInt() > 0n) {
    const h = heightIndex(current);
    const peakSize = new Uint64(1).shl(h + 1).sub(new Uint64(1)); // (1 << (h+1)) - 1
    leafCount = leafCount.add(new Uint64(1).shl(h)); // Add 2^h leaves
    current = current.sub(peakSize);
  }

  return leafCount.sub(new Uint64(1)); // Convert to zero-based
}

/**
 * Converts MMR index to MMR position (index + 1)
 *
 * @param mmrIndex - Zero-based MMR index
 * @returns One-based MMR position
 */
export function mmrPosition(mmrIndex: Uint64): Uint64 {
  return mmrIndex.add(new Uint64(1));
}

/**
 * Returns the number of nodes given a height index (g)
 *
 * n = 2^(g+1) - 1 = (2 << g) - 1
 * Translated from go-merklelog/mmr/size.go HeightIndexSize
 */
export function mmrSizeFromHeightIndex(heightIndex: number): Uint64 {
  return new Uint64(1).shl(heightIndex + 1).sub(new Uint64(1));
}

/**
 * Returns the number of leaves given an MMR size
 *
 * f = (n + 1) / 2
 */
export function leafCount(mmrSize: Uint64): Uint64 {
  return mmrSize.add(new Uint64(1)).shr(1);
}

/**
 * Returns the number of leaves given a height index
 *
 * f = 2^g = 1 << g
 */
export function leafCountFromHeightIndex(heightIndex: number): Uint64 {
  return new Uint64(1).shl(heightIndex);
}

