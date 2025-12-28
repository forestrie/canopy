/**
 * Request body for the pull endpoint.
 */
export interface PullRequest {
  /** Unique identifier for this poller instance (e.g., ranger pod ID) */
  pollerId: string;
  /** Maximum number of entries to return across all logs */
  batchSize: number;
  /** How long entries remain invisible after pull, in milliseconds */
  visibilityMs: number;
}
