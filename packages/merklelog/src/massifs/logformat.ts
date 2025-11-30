/**
 * Massif log format functions
 *
 * Functions for calculating offsets and sizes in the massif blob format.
 * Based on the Go implementation in go-merklelog/massifs/logformat.go
 *
 * Reference: https://github.com/datatrails/epic-8120-scalable-proof-mechanisms/blob/main/mmr/forestrie-mmrblobs.md#massif-basic-file-format
 */

/**
 * LogFormat - Constants for massif data format
 *
 * Matching the Go implementation in go-merklelog/massifs/logformat.go
 */
export namespace LogFormat {
  /**
   * ValueBytes defines the width of ALL entries in the log. This fixed width
   * makes it possible to compute mmr current sizes based on knowing only the
   * massif height and the number of bytes in the file.
   */
  export const ValueBytes = 32;

  /**
   * ReservedHeaderSlots reserves a place to put the urkle trie root, used for
   * data recovery and proofs of exclusion, and any related material. And it
   * gives us a little flex in the data format for the initial launch of
   * forestrie. It would be frustrating to need a data migration for want of a
   * few bytes.
   */
  export const ReservedHeaderSlots = 7; // reserves n * ValueBytes at the front of the blob

  /**
   * StartHeaderSize - Size of the start header including reserved slots
   */
  export const StartHeaderSize = ValueBytes + ValueBytes * ReservedHeaderSlots; // 256

  /**
   * StartHeaderEnd - End offset of the start header
   */
  export const StartHeaderEnd = StartHeaderSize;

  /**
   * MaxMmrHeight - Maximum MMR height - no single log can be taller than this
   * Matches the allowable bit size of an mmrIndex.
   * Note that the max height *index* is 63
   */
  export const MaxMmrHeight = 64;

  /**
   * IndexHeaderBytes - Index header bytes - reserved space for trie header data
   */
  export const IndexHeaderBytes = 32;

  /**
   * TrieEntryBytes - Size of each trie entry (trie key + trie value)
   * From go-merklelog/massifs/trieentry.go: TrieEntryBytes = 32 * 2
   */
  export const TrieEntryBytes = 64;
}

/**
 * PeakStackEnd returns the first byte after the massif ancestor peak stack data
 *
 * The peak stack is fixed at MaxMMRHeight entries regardless of how many are
 * actually needed. This makes it possible to trivially compute the node &
 * leaf counts knowing only the byte size of the massif.
 *
 * @param massifHeight - Zero-based massif height index
 * @returns Byte offset of the end of the peak stack
 */
export function peakStackEnd(massifHeight: number): bigint {
  // Calculate directly from constants:
  // PeakStackEnd = FixedHeaderEnd + IndexHeaderBytes + TrieDataSize + MaxMmrHeight*ValueBytes
  // Where:
  // - FixedHeaderEnd = StartHeaderSize
  // - TrieDataSize = TrieEntryBytes * (1 << massifHeight)

  const fixedHeaderEnd = BigInt(LogFormat.StartHeaderSize);
  const trieDataSize = BigInt(LogFormat.TrieEntryBytes * (1 << massifHeight));
  const peakStackSize = BigInt(LogFormat.MaxMmrHeight * LogFormat.ValueBytes);

  return (
    fixedHeaderEnd +
    BigInt(LogFormat.IndexHeaderBytes) +
    trieDataSize +
    peakStackSize
  );
}

/**
 * MassifLogEntries calculates the number of log entries (nodes) in a blob from
 * the length of the blob in bytes.
 *
 * It does this by accounting for the trie entries and other header data.
 * If you know the FirstIndex from the massif start header you can get the
 * overall mmr size by direct addition.
 *
 * Note: this function exists so we can compute the mmrSize from just the blob
 * store metadata: we store the FirstIndex on a blob tag, and the blob
 * metadata includes ContentLength. This means when we are checking if a root
 * seal covers the current log head, we don't need to fetch the log massif blob.
 *
 * @param dataLen - Total length of the massif blob in bytes
 * @param massifHeight - Zero-based massif height index
 * @returns Number of log entries (nodes) in the blob
 * @throws Error if the data length is too short to contain the required headers
 */
export function massifLogEntries(
  dataLen: number,
  massifHeight: number,
): bigint {
  const stackEnd = peakStackEnd(massifHeight);

  if (BigInt(dataLen) < stackEnd) {
    throw new Error(
      `Massif data length ${dataLen} is too short. Minimum required: ${stackEnd} bytes`,
    );
  }

  const mmrByteCount = BigInt(dataLen) - stackEnd;
  return mmrByteCount / BigInt(LogFormat.ValueBytes);
}
