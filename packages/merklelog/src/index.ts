/**
 * @forestrie/merklelog - TypeScript implementation of MMR Merklelog format
 *
 * This package provides TypeScript implementations of the MMR (Merkle Mountain Range)
 * merklelog format as defined by the go-merklelog project.
 *
 * @packageDocumentation
 */

// Export uint64 module
export { Uint64 } from "./uint64/index.js";

// Export massifs module
export { Massif } from "./massifs/massif.js";
export type {
  MassifStart,
  LeafComponent,
  LeafEnumeratorSpec,
  LeafEntry,
} from "./massifs/types.js";
export { MassifStartFmt } from "./massifs/types.js";
export {
  LogFormat,
  Urkle,
  Bloom,
  IndexV2,
  leafCountForMassifHeight,
  leafTableBytes,
  nodeCountMax,
  nodeStoreBytes,
  bloomMBits,
  bloomBitsetBytes,
  bloomRegionBytes,
  indexDataBytesV2,
  peakStackEnd,
  massifLogEntries,
  urkleLeafTableStartFieldIndex,
  urkleLeafTableStartByteOffset,
  createLeafEnumerator,
  leafComponentByteOffset,
  leafComponentSize,
  computeLastMMRIndex,
  isMassifFull,
} from "./massifs/types.js";

export { parseV2StorageObjectPath } from "./massifs/v2storagepaths.js";

// Massif blob node access for MMR proof building (plan-2607-15 §4)
export { openMassifNodeStore } from "./massifs/nodestore.js";
export type { MassifNodeStore } from "./massifs/nodestore.js";

// Content-hash leaf lookup over the massif index region (FOR-373)
export { openMassifLeafIndex, MissingIndexError } from "./massifs/leafindex.js";
export type { MassifLeafIndex, LocatedLeaf } from "./massifs/leafindex.js";

// Export mmr module
export { mmrIndex, massifFirstLeaf, leafMinusSpurSum } from "./mmr/index.js";
export {
  heightIndex,
  height,
  mmrIndexFromLeafIndex,
  leafIndex,
  mmrPosition,
  mmrSizeFromHeightIndex,
  leafCount,
  leafCountFromHeightIndex,
} from "./mmr/math.js";
export {
  bagPeaks,
  calculateRoot,
  verifyInclusion,
  verifyConsistency,
} from "./mmr/algorithms.js";
export { createSyncHasher } from "./mmr/algorithms-sync.js";
export type { Proof, Peak } from "./mmr/types.js";
export type { Hasher } from "./mmr/types.js";

// MMR proof building (pure; store-agnostic) — plan-2607-15 §4 (go: mmr/proof.go, peaks.go)
export {
  inclusionProof,
  peakMMRIndexes,
  peaksBitmap,
  peakIndexForLeafProof,
  indexHeight,
  firstMMRSize,
  massifIndexFromMMRIndex,
  peakStackMap,
} from "./mmr/proof.js";
export type { NodeGetter } from "./mmr/proof.js";
