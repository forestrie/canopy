/**
 * Request body for the ack endpoint.
 */
export interface AckRequest {
  /** Log identifier (16 bytes) */
  logId: ArrayBuffer;
  /** First sequence number to acknowledge (inclusive) */
  fromSeq: number;
  /** Last sequence number to acknowledge (inclusive) */
  toSeq: number;
}

/**
 * Response body from the ack endpoint.
 */
export interface AckResponse {
  /** Number of entries deleted */
  deleted: number;
}
