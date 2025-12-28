/**
 * Request body for the ack endpoint (limit-based).
 *
 * Uses limit-based ack because sequence numbers are allocated globally across
 * all logs, making per-log seq values non-contiguous. See
 * arbor/docs/arc-cloudflare-do-ingress.md section 2.3.
 */
export interface AckRequest {
  /** Log identifier (16 bytes) */
  logId: ArrayBuffer;
  /** Starting sequence number (first entry to acknowledge) */
  seqLo: number;
  /** Number of entries to acknowledge starting from seqLo */
  limit: number;
}

/**
 * Response body from the ack endpoint.
 */
export interface AckResponse {
  /** Number of entries deleted */
  deleted: number;
}
