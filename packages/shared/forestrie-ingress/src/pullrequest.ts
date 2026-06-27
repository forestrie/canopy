/**
 * Request body for the SequencingQueue pull endpoint (forestrie-ingress HTTP).
 * arbor **ranger** polls with a stable {@link PullRequest.pollerId} and lease
 * parameters; responses group entries per log for limit-based ack.
 */
export interface PullRequest {
  /** Unique identifier for this poller instance (e.g., ranger pod ID) */
  pollerId: string;
  /** Maximum number of entries to return across all logs */
  batchSize: number;
  /** How long entries remain invisible after pull, in milliseconds */
  visibilityMs: number;
}
