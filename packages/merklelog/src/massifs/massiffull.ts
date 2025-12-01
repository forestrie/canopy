/**
 * Massif fullness determination functions
 *
 * Functions for determining if a massif is full based on its height and log entries.
 */

/**
 * Determine if a massif is full.
 *
 * @param massifHeight - Massif height (1-based)
 * @param logEntries - Number of log entries (nodes) in the massif
 * @returns True if the massif is full
 */
export function isMassifFull(
  massifHeight: number,
  logEntries: bigint,
): boolean {
  // Convert 1-based height to 0-based height index
  const heightIndex = massifHeight - 1;

  // Expected number of leaves for a full massif: f = 2^g = 1 << heightIndex
  const expectedLeaves = BigInt(1 << heightIndex);

  // Actual number of leaves: f = (n + 1) / 2
  const actualLeaves = (logEntries + 1n) >> 1n;

  return actualLeaves >= expectedLeaves;
}
