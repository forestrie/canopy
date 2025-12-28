/**
 * Queue statistics returned by the stats endpoint.
 */
export interface QueueStats {
  /** Total entries pending (not yet acked) */
  pending: number;
  /** Total entries in dead letter queue */
  deadLetters: number;
  /** Age of oldest pending entry in milliseconds, or null if empty */
  oldestEntryAgeMs: number | null;
  /** Number of active pollers (seen within timeout) */
  activePollers: number;
}
