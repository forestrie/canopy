/**
 * Minimal v2 massif blob builder for merklelog node-store / leaf-index tests.
 *
 * Layout mirrors go-merklelog `massifs/logformat.go` + `indexformat_v2.go`
 * (StartHeader | IndexHeader | bloom bitsets | urkle frontier | leaf table |
 * node store | peak stack | log region). Independent of the code under test.
 */

const VALUE_BYTES = 32;
const RESERVED_HEADER_SLOTS = 7;
const START_HEADER_BYTES = VALUE_BYTES + VALUE_BYTES * RESERVED_HEADER_SLOTS; // 256
const INDEX_HEADER_BYTES = 32;
const MAX_MMR_HEIGHT = 64;
const BLOOM_BITS_PER_ELEMENT_V1 = 10;
const BLOOM_FILTERS = 4;
const BLOOM_HEADER_BYTES_V1 = 32;
const URKLE_FRONTIER_STATE_V1_BYTES = 544;
const URKLE_LEAF_RECORD_BYTES = 128;
const URKLE_NODE_RECORD_BYTES = 64;
const URKLE_LEAF_VALUE_OFFSET = 8; // after 8-byte key
const URKLE_LEAF_KEY_BYTES = 8;

function u64be(view: DataView, offset: number, value: bigint): void {
  view.setBigUint64(offset, value & 0xffffffffffffffffn, false);
}

export interface V2MassifLayout {
  bytes: Uint8Array;
  leafTableStart: number;
  peakStackStart: number;
  logStart: number;
  leafCapacity: number;
}

/**
 * Build v2 massif bytes with `logHashes[i]` at MMR log index i and optional
 * leaf-table content hashes. `leafValues[ordinal]` (if provided) is written to
 * the committed valueBytes column of leaf record `ordinal`, with an incrementing
 * key. When `omitIndex` is true the blob is truncated before the index region
 * (used to exercise MissingIndexError).
 */
export function buildV2Massif(opts: {
  massifHeight: number;
  massifIndex: number;
  logHashes: Uint8Array[];
  leafValues?: Uint8Array[];
}): V2MassifLayout {
  const { massifHeight, massifIndex, logHashes, leafValues = [] } = opts;
  const leafCapacity = 1 << (massifHeight - 1);
  const mBits = BLOOM_BITS_PER_ELEMENT_V1 * leafCapacity;
  const bitsetBytes = Math.ceil(mBits / 8);
  const bloomBitsetsBytes = BLOOM_FILTERS * bitsetBytes;
  const leafTableBytes = leafCapacity * URKLE_LEAF_RECORD_BYTES;
  const nodeStoreBytes = (2 * leafCapacity - 1) * URKLE_NODE_RECORD_BYTES;
  const indexDataBytes =
    bloomBitsetsBytes +
    URKLE_FRONTIER_STATE_V1_BYTES +
    leafTableBytes +
    nodeStoreBytes;

  const trieHeaderEnd = START_HEADER_BYTES + INDEX_HEADER_BYTES;
  const leafTableStart =
    trieHeaderEnd + bloomBitsetsBytes + URKLE_FRONTIER_STATE_V1_BYTES;
  const peakStackStart = trieHeaderEnd + indexDataBytes;
  const logStart = peakStackStart + MAX_MMR_HEIGHT * VALUE_BYTES;

  const bytes = new Uint8Array(logStart + logHashes.length * VALUE_BYTES);
  const view = new DataView(bytes.buffer);

  view.setUint16(21, 2, false); // version
  view.setUint32(23, 1, false); // commitment epoch
  bytes[27] = massifHeight;
  view.setUint32(28, massifIndex, false);

  for (let i = 0; i < logHashes.length; i++) {
    const h = logHashes[i]!;
    if (h.length !== 32) throw new Error(`logHashes[${i}] must be 32 bytes`);
    bytes.set(h, logStart + i * VALUE_BYTES);
  }

  for (let ordinal = 0; ordinal < leafValues.length; ordinal++) {
    const v = leafValues[ordinal]!;
    if (v.length !== 32)
      throw new Error(`leafValues[${ordinal}] must be 32 bytes`);
    const recordOff = leafTableStart + ordinal * URKLE_LEAF_RECORD_BYTES;
    u64be(view, recordOff, BigInt(ordinal + 1)); // arbitrary non-zero key
    bytes.set(v, recordOff + URKLE_LEAF_VALUE_OFFSET);
  }

  return { bytes, leafTableStart, peakStackStart, logStart, leafCapacity };
}

export { URKLE_LEAF_KEY_BYTES };
