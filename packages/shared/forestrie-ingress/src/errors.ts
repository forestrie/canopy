/**
 * Custom error types for SequencingQueue operations.
 *
 * These errors can be caught by callers to provide appropriate HTTP responses.
 */

/**
 * Error thrown when the queue has reached MAX_PENDING capacity.
 *
 * Callers should catch this and return HTTP 503 Service Unavailable
 * with a Retry-After header to implement proper backpressure.
 *
 * See: Cloudflare DO best practices recommend signalling saturation
 * early with 503 to allow clients to back off gracefully.
 */
export class QueueFullError extends Error {
  /** Current number of pending entries */
  readonly pendingCount: number;

  /** Maximum allowed pending entries */
  readonly maxPending: number;

  /** Suggested retry delay in seconds */
  readonly retryAfterSeconds: number;

  constructor(pendingCount: number, maxPending: number) {
    super(`Queue full: pending count ${pendingCount} >= ${maxPending}`);
    this.name = "QueueFullError";
    this.pendingCount = pendingCount;
    this.maxPending = maxPending;

    // Suggest a retry delay based on how full the queue is
    // More full = longer delay to allow draining
    const fillRatio = pendingCount / maxPending;
    if (fillRatio >= 1.0) {
      this.retryAfterSeconds = 30; // Very full, back off significantly
    } else if (fillRatio >= 0.9) {
      this.retryAfterSeconds = 10; // Nearly full
    } else {
      this.retryAfterSeconds = 5; // Approaching capacity
    }
  }
}
