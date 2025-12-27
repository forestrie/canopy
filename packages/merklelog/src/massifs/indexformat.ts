/**
 * Index format constants for v2 massif format
 *
 * Constants for the urkle trie and bloom filter index regions.
 * Based on the Go implementations in:
 * - go-merklelog/urkle/types.go
 * - go-merklelog/bloom/types.go
 * - go-merklelog/massifs/indexformat_v2.go
 */

/**
 * Urkle - Constants for urkle trie format
 */
export namespace Urkle {
  /** Fixed width of hashes and values (32 bytes) */
  export const HashBytes = 32;

  /** Byte width of leafOrdinal in proofs and leaf hashes */
  export const LeafOrdinalBytes = 4;

  /**
   * LeafRecordBytes is the fixed byte width of a leaf table record.
   *
   * v1 layout (extended for Forestrie v2 index needs):
   *   - key_be8 (uint64, 8 bytes)
   *   - valueBytes[32] (committed by trie hash)
   *   - extra1[24] (auxiliary; not committed by the trie hash)
   *   - extra2[32] (auxiliary; not committed by the trie hash)
   *   - extra3[32] (auxiliary; not committed by the trie hash)
   *
   * NOTE: Record size is intentionally a multiple of 32 bytes. To achieve this
   * without truncating valueBytes, we sacrifice 8 bytes from the first extra
   * field.
   */
  export const LeafRecordBytes = 128; // 8 + 32 + 24 + 32 + 32

  /** Fixed byte width of a node store record */
  export const NodeRecordBytes = 64;

  /** Size of FrontierStateV1 snapshot for resuming append-only construction */
  export const FrontierStateV1Bytes = 544; // 32 + 64*8

  // Leaf record field offsets
  export const LeafKeyBytes = 8;
  export const LeafValueBytes = HashBytes;
  export const LeafExtra1Bytes = HashBytes - 8; // 24
  export const LeafExtraBytes = HashBytes; // 32

  export const LeafValueOffset = LeafKeyBytes; // 8
  export const LeafExtraOffset = LeafValueOffset + LeafValueBytes; // 40
  export const LeafExtra1Offset = LeafExtraOffset; // 40
  export const LeafExtra2Offset = LeafExtra1Offset + LeafExtra1Bytes; // 64
  export const LeafExtra3Offset = LeafExtra2Offset + LeafExtraBytes; // 96
}

/**
 * Bloom - Constants for bloom filter format
 */
export namespace Bloom {
  /** Fixed element width (Forestrie log value width) */
  export const ValueBytes = 32;

  /** Number of parallel Bloom filters in this format */
  export const Filters = 4;

  /** Fixed header size for BloomHeaderV1 */
  export const HeaderBytesV1 = 32;

  /** Magic string for BloomHeaderV1 */
  export const MagicV1 = "BLM1";

  /** Version number for v1 */
  export const VersionV1 = 1;

  /** BitOrderLSB0: bit 0 is the least-significant bit of byte 0 */
  export const BitOrderLSB0 = 0;
}

/**
 * IndexV2 - V2 massif index configuration constants
 */
export namespace IndexV2 {
  /**
   * BloomBitsPerElement is the fixed sizing knob for the v2 massif BloomRegion.
   * mBits = bitsPerElement * leafCount, per filter.
   */
  export const BloomBitsPerElement = 10;

  /**
   * BloomK is the number of hash-derived bit positions set per inserted element.
   * For b=10, k≈round(0.693*b)=7.
   */
  export const BloomK = 7;
}

/**
 * Returns the fixed leaf capacity N for a massif height (one-based).
 *
 * In massifs, massifHeight is the one-based height h, so leaf capacity is:
 *   N = 2^(h-1)
 *
 * @param massifHeight - One-based massif height
 * @returns Leaf capacity for the massif
 */
export function leafCountForMassifHeight(massifHeight: number): bigint {
  if (massifHeight === 0) {
    return 0n;
  }
  return 1n << BigInt(massifHeight - 1);
}

/**
 * Returns the required leaf table bytes for leafCount leaves.
 *
 * @param leafCount - Number of leaves
 * @returns Byte size of the leaf table
 */
export function leafTableBytes(leafCount: bigint): bigint {
  return leafCount * BigInt(Urkle.LeafRecordBytes);
}

/**
 * Returns the maximum number of nodes in a binary trie with leafCount keys.
 * For a Patricia/crit-bit style binary trie, node count is <= 2N-1.
 *
 * @param leafCount - Number of leaves
 * @returns Maximum node count
 */
export function nodeCountMax(leafCount: bigint): bigint {
  if (leafCount === 0n) {
    return 0n;
  }
  return 2n * leafCount - 1n;
}

/**
 * Returns the required node store bytes for leafCount leaves.
 *
 * @param leafCount - Number of leaves
 * @returns Byte size of the node store
 */
export function nodeStoreBytes(leafCount: bigint): bigint {
  return nodeCountMax(leafCount) * BigInt(Urkle.NodeRecordBytes);
}

/**
 * Computes mBits = bitsPerElement * leafCount, returning 0 if overflow.
 *
 * @param leafCount - Number of leaves
 * @param bitsPerElement - Bits per element (default: IndexV2.BloomBitsPerElement)
 * @returns mBits value, or 0 if overflow
 */
export function bloomMBits(
  leafCount: bigint,
  bitsPerElement: bigint = BigInt(IndexV2.BloomBitsPerElement),
): bigint {
  const mBits = bitsPerElement * leafCount;
  // Check overflow - mBits should fit in uint32
  if (mBits > 0xffffffffn) {
    return 0n;
  }
  return mBits;
}

/**
 * Returns ceil(mBits/8) - the number of bytes for a single filter bitset.
 *
 * @param mBits - Number of bits
 * @returns Byte size of one filter bitset
 */
export function bloomBitsetBytes(mBits: bigint): bigint {
  return (mBits + 7n) / 8n;
}

/**
 * Returns the required byte length for a 4-way BloomRegion given mBits:
 *   HeaderBytesV1 + 4 * ceil(mBits/8)
 *
 * @param mBits - Number of bits per filter
 * @returns Total byte size of bloom region (header + 4 bitsets)
 */
export function bloomRegionBytes(mBits: bigint): bigint {
  const bitsetBytes = bloomBitsetBytes(mBits);
  return BigInt(Bloom.HeaderBytesV1) + BigInt(Bloom.Filters) * bitsetBytes;
}

/**
 * Returns the byte size of the v2 index data region, excluding the fixed 32B
 * index header.
 *
 * v2 index header (32B) is BloomHeaderV1, and the index data is:
 *   bloom bitsets || urkle frontier || urkle leaf table || urkle node store
 *
 * @param leafCount - Number of leaves
 * @returns Byte size of index data region
 * @throws Error if mBits overflows
 */
export function indexDataBytesV2(leafCount: bigint): bigint {
  const mBits = bloomMBits(leafCount);
  if (mBits === 0n && leafCount > 0n) {
    throw new Error("bloom mBits overflow");
  }
  if (leafCount === 0n) {
    return 0n;
  }

  // Bloom region bytes includes the 32B header; we exclude that here because
  // the massif index header is a fixed 32B already accounted for.
  const bloomRegion = bloomRegionBytes(mBits);
  const bloomBitsetsOnly = bloomRegion - BigInt(Bloom.HeaderBytesV1);

  const frontierBytes = BigInt(Urkle.FrontierStateV1Bytes);
  const ltBytes = leafTableBytes(leafCount);
  const nsBytes = nodeStoreBytes(leafCount);

  return bloomBitsetsOnly + frontierBytes + ltBytes + nsBytes;
}
