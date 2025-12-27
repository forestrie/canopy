/**
 * Result from resolving a content hash to its sequenced position.
 *
 * This is the subset of SequenceRecord returned by queries,
 * omitting the content hash since the caller already knows it.
 */
export interface IndexEntry {
  /** IDTimestamp from the Urkle leaf key */
  idtimestamp: bigint;
  /** MMR index of the leaf in the log */
  mmrIndex: bigint;
  /** Massif height (1-64) for constructing the receipt URL */
  massifHeight: number;
}
