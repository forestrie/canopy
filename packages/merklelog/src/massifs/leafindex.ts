/**
 * Content-hash → mmrIndex leaf lookup over a v2 massif index region (FOR-373).
 *
 * The v2 massif index region carries, per leaf ordinal, a fixed-width record
 * whose committed `valueBytes[32]` is the leaf's content hash — the same value
 * committed by the urkle trie (go-merklelog `urkle/leafrecord.go`,
 * `massifs/indexformat_v2.go`; plan-2607-15 §1.1). The urkle trie itself is
 * keyed by the 8-byte leaf key (idtimestamp) for duplicate/exclusion detection,
 * so content-hash resolution reads the leaf table's value column directly and
 * maps the matching ordinal back to an MMR index
 * (`urkle.LeafOrdinalToMMRIndex`).
 *
 * This lets `forestrie create-receipt --content-hash <hex>` locate a leaf's
 * mmrIndex from a massif blob alone, with no external mapping. A negative
 * lookup (`null`) is distinguishable from absence-of-index: a blob with no
 * index region throws `MissingIndexError`, while a searched-but-not-present
 * hash returns `null`.
 *
 * Browser-safe: pure buffer arithmetic, no node builtins (ADR-0048).
 */

import { Massif } from "./massif.js";
import { LogFormat } from "./logformat.js";
import { Urkle, leafCountForMassifHeight } from "./indexformat.js";
import { urkleLeafTableStartByteOffset } from "./urkleindex.js";
import { peakStackEnd } from "./peakstackend.js";
import { massifLogEntries } from "./massiflogentries.js";
import { firstMMRSize, peaksBitmap } from "../mmr/proof.js";
import { mmrIndex as mmrIndexFromLeafIndex } from "../mmr/index.js";

const HASH_BYTES = Urkle.LeafValueBytes; // 32
const KEY_BYTES = Urkle.LeafKeyBytes; // 8 (idtimestamp, big-endian)
const VALUE_OFFSET = Urkle.LeafValueOffset; // 8 (after the 8-byte key)
const RECORD_BYTES = Urkle.LeafRecordBytes; // 128

/**
 * Thrown when the blob carries no populated index region, so a content-hash
 * lookup cannot even be attempted. Callers distinguish this from a `null`
 * (searched, not found) result.
 */
export class MissingIndexError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MissingIndexError";
  }
}

/**
 * A located leaf: its MMR index plus the 8-byte idtimestamp (big-endian) the
 * urkle leaf record is keyed by. Together these are the two halves of the
 * permanent entry id (`idtimestamp_be8 || mmrIndex_be8`).
 */
export interface LocatedLeaf {
  mmrIndex: bigint;
  idtimestampBe8: Uint8Array;
}

/** Content-hash leaf lookup over one massif blob (FOR-373). */
export interface MassifLeafIndex {
  /**
   * MMR index of the leaf whose committed content hash equals `h`, or `null`
   * when no populated leaf in this massif carries that hash. `h` must be 32
   * bytes.
   */
  findByContentHash(h: Uint8Array): bigint | null;
  /**
   * Like {@link findByContentHash} but also recovers the leaf's idtimestamp
   * (the 8-byte urkle leaf key), so a caller can reconstruct the full entry id
   * offline. Returns `null` when the hash is not present. `h` must be 32 bytes.
   */
  findLeafByContentHash(h: Uint8Array): LocatedLeaf | null;
  /** Number of populated leaves in this blob. */
  leafCount: number;
}

function equals32(a: Uint8Array, aOff: number, b: Uint8Array): boolean {
  for (let i = 0; i < HASH_BYTES; i++) {
    if (a[aOff + i] !== b[i]) return false;
  }
  return true;
}

/**
 * Leaf index of the first leaf in the massif whose first MMR index is
 * `firstMMRIndex`. (go-merklelog `mmr/leafcount.go` LeafIndex)
 */
function leafIndexFromMMRIndex(firstMMRIndex: bigint): bigint {
  if (firstMMRIndex === 0n) return 0n;
  return peaksBitmap(firstMMRSize(firstMMRIndex)) - 1n;
}

/**
 * Open a v2 massif blob for content-hash leaf lookups.
 *
 * @throws MissingIndexError if the blob is too short to contain the fixed index
 *   region for its declared massif height (no index present).
 */
export function openMassifLeafIndex(massifBytes: Uint8Array): MassifLeafIndex {
  const massif = new Massif(massifBytes);
  const start = massif.getStart();
  const massifHeight = start.massifHeight;
  if (
    !Number.isInteger(massifHeight) ||
    massifHeight < 1 ||
    massifHeight > LogFormat.MaxMmrHeight
  ) {
    throw new Error(`massif header has invalid height ${massifHeight}`);
  }
  const firstIndex = start.firstIndex;

  const leafTableStart = urkleLeafTableStartByteOffset(massifHeight);
  const capacity = Number(leafCountForMassifHeight(massifHeight));
  const leafTableBytes = capacity * RECORD_BYTES;
  const stackEnd = peakStackEnd(massifHeight);

  // The index region must fit before the fixed peak stack + log region. A blob
  // shorter than that has no populated index to search.
  if (massifHeight > 1 && BigInt(leafTableStart + leafTableBytes) > stackEnd) {
    throw new Error("massif index region math is inconsistent");
  }
  if (BigInt(massifBytes.byteLength) < stackEnd) {
    throw new MissingIndexError(
      "massif blob too short for a v2 index region (no index present)",
    );
  }

  // Only leaves actually appended have populated records. Derive the populated
  // leaf count from the log node count (index records are written 1:1 with
  // appended leaves). Never exceed the fixed capacity for the height.
  const logNodeCount = massifLogEntries(massifBytes.byteLength, massifHeight);
  const firstLeafIndex = leafIndexFromMMRIndex(firstIndex);
  let populated = 0;
  for (let ordinal = 0; ordinal < capacity; ordinal++) {
    // MMR index of leaf (firstLeafIndex + ordinal), relative to this blob's
    // firstIndex, must be within the log node count.
    const leafMMRIndex = mmrIndexFromLeafIndex(
      firstLeafIndex + BigInt(ordinal),
    );
    if (leafMMRIndex - firstIndex >= logNodeCount) break;
    populated = ordinal + 1;
  }

  /** Ordinal of the populated leaf whose value column equals `h`, or -1. */
  const ordinalForContentHash = (h: Uint8Array): number => {
    if (h.length !== HASH_BYTES) {
      throw new Error(
        `content hash must be ${HASH_BYTES} bytes, got ${h.length}`,
      );
    }
    for (let ordinal = 0; ordinal < populated; ordinal++) {
      const recordOff = leafTableStart + ordinal * RECORD_BYTES;
      const valueOff = recordOff + VALUE_OFFSET;
      if (valueOff + HASH_BYTES > massifBytes.byteLength) break;
      if (equals32(massifBytes, valueOff, h)) return ordinal;
    }
    return -1;
  };

  const findByContentHash = (h: Uint8Array): bigint | null => {
    const ordinal = ordinalForContentHash(h);
    if (ordinal < 0) return null;
    return mmrIndexFromLeafIndex(firstLeafIndex + BigInt(ordinal));
  };

  const findLeafByContentHash = (h: Uint8Array): LocatedLeaf | null => {
    const ordinal = ordinalForContentHash(h);
    if (ordinal < 0) return null;
    // The leaf record is `[key(8) || value(32) || …]`; the key IS the
    // big-endian idtimestamp the sealer assigned (go-merklelog urkle leafrecord).
    const keyOff = leafTableStart + ordinal * RECORD_BYTES;
    return {
      mmrIndex: mmrIndexFromLeafIndex(firstLeafIndex + BigInt(ordinal)),
      idtimestampBe8: massifBytes.slice(keyOff, keyOff + KEY_BYTES),
    };
  };

  return { findByContentHash, findLeafByContentHash, leafCount: populated };
}
