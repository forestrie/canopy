/**
 * Urkle index helpers for efficient leaf data access
 *
 * Provides helpers for computing field indices and efficiently enumerating
 * urkle leaf data components.
 */

import { LogFormat } from "./logformat.js";
import {
  Urkle,
  Bloom,
  leafCountForMassifHeight,
  bloomMBits,
  bloomBitsetBytes,
} from "./indexformat.js";

/**
 * Leaf components that can be read via the enumerator.
 */
export type LeafComponent =
  | "idtimestamp"
  | "valueBytes"
  | "extra1"
  | "extra2"
  | "extra3";

/**
 * Byte offsets within a leaf record for each component.
 */
const LEAF_COMPONENT_OFFSETS: Record<LeafComponent, number> = {
  idtimestamp: 0,
  valueBytes: Urkle.LeafValueOffset, // 8
  extra1: Urkle.LeafExtra1Offset, // 40
  extra2: Urkle.LeafExtra2Offset, // 64
  extra3: Urkle.LeafExtra3Offset, // 96
};

/**
 * Byte sizes for each leaf component.
 */
const LEAF_COMPONENT_SIZES: Record<LeafComponent, number> = {
  idtimestamp: Urkle.LeafKeyBytes, // 8
  valueBytes: Urkle.LeafValueBytes, // 32
  extra1: Urkle.LeafExtra1Bytes, // 24
  extra2: Urkle.LeafExtraBytes, // 32
  extra3: Urkle.LeafExtraBytes, // 32
};

/**
 * Returns the field index (for use with Massif.fieldref) of the start of the
 * urkle leaf table data region.
 *
 * The field index is the offset in units of ValueBytes (32 bytes), which can be
 * passed directly to Massif.fieldref() to get a view of the data.
 *
 * V2 layout before leaf table:
 *   StartHeader (256 bytes = 8 fields)
 *   IndexHeader (32 bytes = 1 field)
 *   BloomBitsets (4 * ceil(mBits/8))
 *   FrontierState (544 bytes)
 *
 * @param massifHeight - One-based massif height
 * @returns Field index (in units of 32-byte fields) where the leaf table starts
 */
export function urkleLeafTableStartFieldIndex(massifHeight: number): number {
  const leafCount = leafCountForMassifHeight(massifHeight);
  const mBits = bloomMBits(leafCount);
  const bloomBitsetsOnly =
    BigInt(Bloom.Filters) * bloomBitsetBytes(mBits > 0n ? mBits : 0n);

  // Byte offset calculation
  const startHeaderBytes = BigInt(LogFormat.StartHeaderSize); // 256
  const indexHeaderBytes = BigInt(LogFormat.IndexHeaderBytes); // 32
  const frontierBytes = BigInt(Urkle.FrontierStateV1Bytes); // 544

  const byteOffset =
    startHeaderBytes + indexHeaderBytes + bloomBitsetsOnly + frontierBytes;

  // Convert to field index (each field is 32 bytes)
  // Note: this should be an exact division for valid massif heights
  return Number(byteOffset / BigInt(LogFormat.ValueBytes));
}

/**
 * Returns the byte offset within a massif buffer where the urkle leaf table
 * starts. This is useful for direct byte-level access.
 *
 * @param massifHeight - One-based massif height
 * @returns Byte offset where the leaf table starts
 */
export function urkleLeafTableStartByteOffset(massifHeight: number): number {
  const leafCount = leafCountForMassifHeight(massifHeight);
  const mBits = bloomMBits(leafCount);
  const bloomBitsetsOnly =
    BigInt(Bloom.Filters) * bloomBitsetBytes(mBits > 0n ? mBits : 0n);

  const startHeaderBytes = BigInt(LogFormat.StartHeaderSize);
  const indexHeaderBytes = BigInt(LogFormat.IndexHeaderBytes);
  const frontierBytes = BigInt(Urkle.FrontierStateV1Bytes);

  return Number(
    startHeaderBytes + indexHeaderBytes + bloomBitsetsOnly + frontierBytes,
  );
}

/**
 * LeafEnumeratorSpec specifies which leaf components to enumerate.
 *
 * Each component that is true will be read and returned during enumeration.
 */
export interface LeafEnumeratorSpec {
  idtimestamp?: boolean;
  valueBytes?: boolean;
  extra1?: boolean;
  extra2?: boolean;
  extra3?: boolean;
}

/**
 * LeafEntry represents a single leaf's data components.
 *
 * Only the components specified in the enumerator spec will be populated.
 * Each component provides a DataView for efficient typed access.
 */
export interface LeafEntry {
  /** Leaf ordinal (0-based index) */
  ordinal: number;
  /** ID timestamp as bigint (if idtimestamp was requested) */
  idtimestamp?: bigint;
  /** Committed value bytes as Uint8Array view (if valueBytes was requested) */
  valueBytes?: Uint8Array;
  /** Extra1 field as Uint8Array view (24 bytes, if extra1 was requested) */
  extra1?: Uint8Array;
  /** Extra2 field as Uint8Array view (32 bytes, if extra2 was requested) */
  extra2?: Uint8Array;
  /** Extra3 field as Uint8Array view (32 bytes, if extra3 was requested) */
  extra3?: Uint8Array;
}

/**
 * Creates an efficient leaf enumerator for iterating through urkle leaf data.
 *
 * The enumerator returns a generator function that yields LeafEntry objects
 * for each leaf in the massif. Only the components specified in the spec
 * are read and returned, minimizing overhead.
 *
 * The enumerator uses DataView for efficient typed access without copying.
 *
 * @param buffer - The massif buffer (Uint8Array)
 * @param massifHeight - One-based massif height
 * @param leafCount - Number of leaves to enumerate (from start position)
 * @param spec - Specification of which components to read
 * @param start - Starting leaf ordinal (0-based, defaults to 0)
 * @returns Generator that yields LeafEntry objects
 *
 * @example
 * ```typescript
 * const enumerate = createLeafEnumerator(
 *   massif.buffer,
 *   massifHeight,
 *   actualLeafCount,
 *   { idtimestamp: true, valueBytes: true },
 *   0 // start from first leaf
 * );
 *
 * for (const leaf of enumerate()) {
 *   console.log(leaf.ordinal, leaf.idtimestamp, leaf.valueBytes);
 * }
 * ```
 */
export function createLeafEnumerator(
  buffer: Uint8Array,
  massifHeight: number,
  leafCount: number,
  spec: LeafEnumeratorSpec,
  start: number = 0,
): () => Generator<LeafEntry, void, unknown> {
  const leafTableStart = urkleLeafTableStartByteOffset(massifHeight);
  const recordBytes = Urkle.LeafRecordBytes;

  // Pre-compute which components we need to read
  const readIdtimestamp = spec.idtimestamp ?? false;
  const readValueBytes = spec.valueBytes ?? false;
  const readExtra1 = spec.extra1 ?? false;
  const readExtra2 = spec.extra2 ?? false;
  const readExtra3 = spec.extra3 ?? false;

  // Create DataView for the buffer (reused for all reads)
  const dataView = new DataView(
    buffer.buffer,
    buffer.byteOffset,
    buffer.byteLength,
  );

  return function* (): Generator<LeafEntry, void, unknown> {
    for (let i = 0; i < leafCount; i++) {
      const ordinal = start + i;
      const recordOffset = leafTableStart + ordinal * recordBytes;

      const entry: LeafEntry = { ordinal };

      if (readIdtimestamp) {
        entry.idtimestamp = dataView.getBigUint64(recordOffset, false);
      }

      if (readValueBytes) {
        entry.valueBytes = buffer.subarray(
          recordOffset + LEAF_COMPONENT_OFFSETS.valueBytes,
          recordOffset +
            LEAF_COMPONENT_OFFSETS.valueBytes +
            LEAF_COMPONENT_SIZES.valueBytes,
        );
      }

      if (readExtra1) {
        entry.extra1 = buffer.subarray(
          recordOffset + LEAF_COMPONENT_OFFSETS.extra1,
          recordOffset +
            LEAF_COMPONENT_OFFSETS.extra1 +
            LEAF_COMPONENT_SIZES.extra1,
        );
      }

      if (readExtra2) {
        entry.extra2 = buffer.subarray(
          recordOffset + LEAF_COMPONENT_OFFSETS.extra2,
          recordOffset +
            LEAF_COMPONENT_OFFSETS.extra2 +
            LEAF_COMPONENT_SIZES.extra2,
        );
      }

      if (readExtra3) {
        entry.extra3 = buffer.subarray(
          recordOffset + LEAF_COMPONENT_OFFSETS.extra3,
          recordOffset +
            LEAF_COMPONENT_OFFSETS.extra3 +
            LEAF_COMPONENT_SIZES.extra3,
        );
      }

      yield entry;
    }
  };
}

/**
 * Returns the byte offset of a specific leaf record's component.
 *
 * @param massifHeight - One-based massif height
 * @param leafOrdinal - Zero-based leaf ordinal
 * @param component - Which component to locate
 * @returns Byte offset of the component within the massif buffer
 */
export function leafComponentByteOffset(
  massifHeight: number,
  leafOrdinal: number,
  component: LeafComponent,
): number {
  const leafTableStart = urkleLeafTableStartByteOffset(massifHeight);
  const recordOffset = leafTableStart + leafOrdinal * Urkle.LeafRecordBytes;
  return recordOffset + LEAF_COMPONENT_OFFSETS[component];
}

/**
 * Returns the size in bytes of a leaf component.
 *
 * @param component - Which component
 * @returns Size in bytes
 */
export function leafComponentSize(component: LeafComponent): number {
  return LEAF_COMPONENT_SIZES[component];
}
