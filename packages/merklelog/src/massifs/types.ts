/**
 * Re-exports for massifs module types and constants
 *
 * This file serves as a convenience re-export point for external consumers.
 * Types and interfaces are organized into individual files to:
 * 1. Avoid circular dependencies
 * 2. Avoid monolithic types.ts files
 * 3. Keep related code (interfaces and their implementations) together
 */

// Re-export MassifStart interface and format namespace
export type { MassifStart } from "./massifstart.js";
export { MassifStartFmt } from "./massifstart.js";

// Re-export log format constants
export { LogFormat } from "./logformat.js";

// Re-export index format constants and functions (v2)
export {
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
} from "./indexformat.js";

// Re-export peakStackEnd and massifLogEntries
export { peakStackEnd } from "./peakstackend.js";
export { massifLogEntries } from "./massiflogentries.js";

// Re-export urkle index helpers
export {
  urkleLeafTableStartFieldIndex,
  urkleLeafTableStartByteOffset,
  createLeafEnumerator,
  leafComponentByteOffset,
  leafComponentSize,
} from "./urkleindex.js";
export type {
  LeafComponent,
  LeafEnumeratorSpec,
  LeafEntry,
} from "./urkleindex.js";

// Re-export MMR index functions
export { computeLastMMRIndex } from "./mmrindex.js";

// Re-export massif fullness functions
export { isMassifFull } from "./massiffull.js";
