/**
 * MMR index calculation functions
 *
 * These functions are needed by the massifs module for computing
 * firstIndex and peakStackLen.
 *
 * Also exports the core mmrIndex function for converting leaf indices to MMR indices.
 */

/**
 * Returns the number of peaks preceding iLeaf that the future tree requires.
 *
 * This corresponds to the number of preceding nodes that will be required to
 * derive future interior nodes. If those preceding nodes are maintained in a
 * stack, this is the current length of the stack.
 *
 * Translated from go-merklelog/mmr/spurs.go LeafMinusSpurSum
 */
export function leafMinusSpurSum(leafIndex: bigint): bigint {
  let sum = leafIndex;
  let current = leafIndex >> 1n;
  while (current > 0n) {
    sum -= current;
    current >>= 1n;
  }
  return sum;
}

/**
 * Returns the MMR index of the first leaf in the massif blob identified by massifIndex
 *
 * Translated from go-merklelog/massifs/massifstart.go MassifFirstLeaf
 */
export function massifFirstLeaf(
  massifHeight: number,
  massifIndex: number,
): bigint {
  // The number of nodes 'm' in a massif is: m = (1 << h) - 1
  const m = BigInt((1 << massifHeight) - 1);

  // The number of leaves 'f' in every massif: f = (m + 1) / 2
  const f = (m + 1n) >> 1n;

  // The first leaf index is then: leafIndex = f * massifIndex
  const leafIndex = f * BigInt(massifIndex);

  // Apply MMRIndex to the leaf index to get the MMR index
  return mmrIndex(leafIndex);
}

/**
 * Returns the node index for the leaf e
 *
 * Args:
 *   - leafIndex: the leaf index, where the leaves are numbered consecutively, ignoring interior nodes.
 *
 * Returns:
 *   The mmr index for the element leafIndex
 *
 * Translated from go-merklelog/mmr/mmrindex.go MMRIndex
 */
export function mmrIndex(leafIndex: bigint): bigint {
  let sum = 0n;
  let current = leafIndex;

  while (current > 0n) {
    // Find the position of the most significant bit (height)
    const h = BigInt(current.toString(2).length);
    sum += (1n << h) - 1n;
    const half = 1n << (h - 1n);
    current -= half;
  }

  return sum;
}
