/**
 * Which massif holds a leaf. A massif of one-based height h holds
 * 2^(h-1) leaves; see {@link leafCountForMassifHeight} and the
 * go-merklelog notation in
 * [mmr-math-cheatsheet.md](https://github.com/forestrie/go-merklelog/blob/main/mmr-math-cheatsheet.md).
 * Mirrors go-merklelog `massifs/massifindex.go` MassifIndexFromLeafIndex,
 * which arbor's ranger uses when it commits massifs.
 */

import { leafCountForMassifHeight } from "./indexformat.js";

/**
 * Returns the zero-based index of the massif that holds the leaf at
 * `leafIndex` (zero-based, counting leaves only).
 *
 * @param massifHeight - One-based massif height (h >= 1)
 * @throws RangeError when massifHeight is 0, which holds no leaves
 */
export function massifIndexFromLeafIndex(
  massifHeight: number,
  leafIndex: bigint | number,
): bigint {
  const leavesPerMassif = leafCountForMassifHeight(massifHeight);
  if (leavesPerMassif === 0n) {
    throw new RangeError("massifHeight must be at least 1");
  }
  return BigInt(leafIndex) / leavesPerMassif;
}
