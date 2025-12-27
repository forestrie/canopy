/**
 * Massif log format constants
 *
 * Constants for calculating offsets and sizes in the massif blob format.
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
   * IndexHeaderBytes - Index header bytes - reserved space for index header.
   * In v2, this 32B region is the BloomHeaderV1.
   */
  export const IndexHeaderBytes = 32;
}
