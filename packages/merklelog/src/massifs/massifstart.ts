/**
 * MassifStart - Header information for a massif blob
 *
 * The massif start is a 32-byte field encoding bookkeeping information
 * required in a blob to allow for efficient correctness checks.
 */
export interface MassifStart {
  /** Reserved field (bytes 0-7) */
  reserved: bigint;
  /** Last ID timestamp (bytes 8-15) */
  lastID: bigint;
  /** Version (bytes 21-22) */
  version: number;
  /** Commitment epoch (bytes 23-26) */
  commitmentEpoch: number;
  /** Massif height (byte 27) */
  massifHeight: number;
  /** Massif index (bytes 28-31) */
  massifIndex: number;
  /** First MMR index in this massif (computed) */
  firstIndex: bigint;
  /** Peak stack length (computed) */
  peakStackLen: bigint;
}

/**
 * MassifStartFmt - Format constants for MassifStart fields
 *
 * Byte offsets and sizes for MassifStart fields.
 * Matching the Go implementation in go-merklelog/massifs/massifstart.go
 */
export namespace MassifStartFmt {
  /** Last ID timestamp field - first byte offset */
  export const LastIdFirstByte = 8;
  /** Last ID timestamp field - size in bytes */
  export const LastIdSize = 8;
  /** Last ID timestamp field - end byte offset */
  export const LastIdEnd = LastIdFirstByte + LastIdSize;

  /** Version field - first byte offset */
  export const VersionFirstByte = 21;
  /** Version field - size in bytes */
  export const VersionSize = 2;
  /** Version field - end byte offset */
  export const VersionEnd = VersionFirstByte + VersionSize;

  /** Commitment epoch field - first byte offset */
  export const EpochFirstByte = VersionEnd; // 23
  /** Commitment epoch field - size in bytes */
  export const EpochSize = 4;
  /** Commitment epoch field - end byte offset */
  export const EpochEnd = EpochFirstByte + EpochSize;

  /** Massif height field - first byte offset */
  export const MassifHeightFirstByte = EpochEnd; // 27
  /** Massif height field - size in bytes */
  export const MassifHeightSize = 1;
  /** Massif height field - end byte offset */
  export const MassifHeightEnd = MassifHeightFirstByte + MassifHeightSize;

  /** Massif index field - first byte offset */
  export const MassifFirstByte = MassifHeightEnd; // 28
  /** Massif index field - size in bytes */
  export const MassifSize = 4;
  /** Massif index field - end byte offset */
  export const MassifEnd = MassifFirstByte + MassifSize;
}
