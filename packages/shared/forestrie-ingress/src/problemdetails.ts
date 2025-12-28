/**
 * RFC 9457 Problem Details for HTTP APIs
 *
 * Used for error responses from the queue endpoints.
 */

/**
 * RFC 9457 Problem Details object.
 */
export interface ProblemDetails {
  /**
   * A URI reference that identifies the problem type.
   * Example: "https://forestrie.io/problems/queue-full"
   */
  type: string;

  /**
   * A short, human-readable summary of the problem type.
   * Example: "Queue capacity exceeded"
   */
  title: string;

  /**
   * The HTTP status code.
   */
  status: number;

  /**
   * A human-readable explanation specific to this occurrence.
   * Example: "Pending count 100000 exceeds limit"
   */
  detail?: string;

  /**
   * A URI reference that identifies the specific occurrence.
   * Optional and typically omitted for queue errors.
   */
  instance?: string;
}

/**
 * Well-known problem types for the ingress queue.
 */
export const PROBLEM_TYPES = {
  /** Queue has reached MAX_PENDING capacity */
  QUEUE_FULL: "https://forestrie.io/problems/queue-full",
  /** Extra field exceeds 32 byte limit */
  INVALID_EXTRA_SIZE: "https://forestrie.io/problems/invalid-extra-size",
  /** Required field missing or malformed */
  INVALID_REQUEST: "https://forestrie.io/problems/invalid-request",
  /** Internal server error */
  INTERNAL_ERROR: "https://forestrie.io/problems/internal-error",
} as const;

/**
 * Content-Type for Problem Details responses.
 */
export const PROBLEM_CONTENT_TYPE = "application/problem+json";
