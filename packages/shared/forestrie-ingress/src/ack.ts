/**
 * Request body for the ack endpoint (limit-based).
 *
 * Uses limit-based ack because sequence numbers are allocated globally across
 * all logs, making per-log seq values non-contiguous. See
 * [ingress ack model](https://github.com/forestrie/arbor/blob/main/docs/arc-cloudflare-do-ingress.md#23-ack-model-limit-based).
 *
 * With return path unification (Phase 9), ack also records leaf indices
 * to enable direct registration status queries from the DO.
 * massifIndex is derived: floor(leafIndex / (1 << massifHeight))
 */
export interface AckRequest {
  /** Log identifier (16 bytes) */
  logId: ArrayBuffer;
  /** Starting sequence number (first entry to acknowledge) */
  seqLo: number;
  /** Number of entries to acknowledge starting from seqLo */
  limit: number;
  /** First leaf index in the committed batch */
  firstLeafIndex: number;
  /** Massif height (log2 of leaves per massif) - used to derive massifIndex */
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
  /** Leaf index within the log's merkle tree */
  leafIndex: number;
  /** Massif index containing this leaf */
  massifIndex: number;
}
