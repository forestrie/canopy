/**
 * Trie entry reading functions
 *
 * Functions for reading and parsing trie entry data from massifs.
 */

import type { Massif } from "./massif.js";
import { LogFormat } from "./logformat.js";
import { TrieEntryFmt } from "./triekey.js";
import { mmrIndex } from "../mmr/index.js";

/**
 * Trie entry data extracted from a massif.
 */
export interface TrieEntryData {
  /** ExtraData0 (24 bytes) - contains fenceIndex at bytes 16-23 */
  extraData0: Uint8Array;
  /** ID timestamp (8 bytes, big-endian uint64) */
  idTimestamp: bigint;
  /** ExtraData1 (32 bytes) - content SHA256 hash from extended storage */
  extraData1: Uint8Array;
  /** Full trie entry (64 bytes) */
  trieEntry: Uint8Array;
  /** MMR index for this leaf */
  mmrIndex: bigint;
  /** Fence index extracted from extraData0 */
  fenceIndex: bigint;
}

/**
 * Read trie entry data from a massif at the given trie index.
 *
 * @param massif - Massif instance
 * @param trieIndex - Trie index (zero-based, same as leaf index within massif)
 * @param heightIndex - Zero-based massif height index
 * @param globalLeafIndex - Global leaf index (across all massifs)
 * @returns Trie entry data including extraData0, idTimestamp, extraData1, and mmrIndex
 */
export function readTrieEntry(
  massif: Massif,
  trieIndex: number,
  heightIndex: number,
  globalLeafIndex: bigint,
): TrieEntryData {
  // Calculate trie data start offset
  // indexStart = StartHeaderSize + IndexHeaderBytes = 256 + 32 = 288
  const indexStart = LogFormat.StartHeaderSize + LogFormat.IndexHeaderBytes;

  // Calculate trie entry offset
  const trieEntryOffset = indexStart + trieIndex * TrieEntryFmt.TrieEntryBytes;

  // Read full trie entry (64 bytes)
  const trieEntry = massif.readBytes(
    trieEntryOffset,
    TrieEntryFmt.TrieEntryBytes,
  );

  // Read extraData0 (24 bytes at offset + 32)
  const extraData0 = trieEntry.slice(
    TrieEntryFmt.ExtraBytesStart,
    TrieEntryFmt.ExtraBytesEnd,
  );

  // Extract fenceIndex from extraData0 (bytes 16-23, big-endian uint64)
  const fenceIndexView = new DataView(
    extraData0.buffer,
    extraData0.byteOffset + 16,
    8,
  );
  const fenceIndex = fenceIndexView.getBigUint64(0, false); // false = big-endian

  // Read idTimestamp (8 bytes at offset + 56)
  const idTimestampView = new DataView(
    trieEntry.buffer,
    trieEntry.byteOffset + TrieEntryFmt.IdTimestampStart,
    TrieEntryFmt.IdTimestampSize,
  );
  const idTimestamp = idTimestampView.getBigUint64(0, false); // false = big-endian

  // Calculate extended storage offset for extraData1
  // TrieDataSize = 64 * (1 << heightIndex)
  const trieDataSize = TrieEntryFmt.TrieEntryBytes * (1 << heightIndex);
  const trieEntryXOffset = trieEntryOffset + trieDataSize;

  // Read extraData1 (32 bytes from extended storage)
  const extraData1 = massif.readBytes(trieEntryXOffset, 32);

  // Calculate MMR index for this leaf using global leaf index
  const mmrIdx = mmrIndex(globalLeafIndex);

  return {
    extraData0,
    idTimestamp,
    extraData1,
    trieEntry,
    mmrIndex: mmrIdx,
    fenceIndex,
  };
}
