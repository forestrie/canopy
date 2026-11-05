/**
 * Request body for the ack endpoint (limit-based).
 *
 * Uses limit-based ack because sequence numbers are allocated globally across
 * all logs, making per-log seq values non-contiguous. See
 * [ingress ack model](https://github.com/forestrie/arbor/blob/main/docs/arc-cloudflare-do-ingress.md#23-ack-model-limit-based).
 *
 * With return path unification (Phase 9), ack also records leaf indices
 * to enable direct registration status queries from the DO. Readers derive
 * the massif from the leaf index; see {@link AckRequest.massifHeight}.
 *
 * Leaf indices are uint64: arbor's ranger sends `firstLeafIndex` as CBOR
 * major type 0, which decodes to `bigint` above 2^53, so they are carried as
 * `bigint` end to end and never as `number`.
 *
 * An ack names the batch it acknowledges: `seqLo`, `seqHi` and `leaseExpiry`
 * echo the pull's LogGroup and lease. The DO marks only the rows that pull
 * leased, and refuses the ack (marking nothing) unless exactly `limit` of
 * them are still pending under that lease. A batch that was re-pulled,
 * dead-lettered or already sequenced since is therefore never shifted onto
 * other rows (FOR-655).
 */
export interface AckRequest {
  /** Log identifier (16 bytes) */
  logId: ArrayBuffer;
  /** First sequence number of the pulled LogGroup */
  seqLo: number;
  /** Last sequence number of the pulled LogGroup */
  seqHi: number;
  /** The pull response's leaseExpiry (ms); identifies the pull's lease */
  leaseExpiry: number;
  /** Number of entries committed: every entry of the LogGroup */
  limit: number;
  /** First leaf index in the committed batch (uint64) */
  firstLeafIndex: bigint;
  /**
   * One-based massif height h that ranger commits massifs at: a massif holds
   * 2^(h-1) leaves (go-merklelog urkle.LeafCountForMassifHeight). The DO uses
   * it only to size how many sequenced entries it retains.
   */
  massifHeight: number;
}

/**
 * Response body from the ack endpoint after ranger commits a batch.
 */
export interface AckResponse {
  /** Number of entries marked as sequenced */
  acked: number;
}

/**
 * Result of resolving a content hash to its sequencing position.
 * Returned by the resolveContent RPC method.
 */
export interface SequencingResult {
  /**
   * Leaf index within the log's merkle tree. Derive the massif that holds it
   * with `massifIndexFromLeafIndex` (@forestrie/merklelog). uint64.
   */
  leafIndex: bigint;
}
