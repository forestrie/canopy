/**
 * How many sequenced entries the SequencingQueue keeps per log as its
 * resolveContent cache (registration status and grant dedupe in canopy-api).
 * Entries evicted from it resolve as "not yet sequenced".
 *
 * Sized in massifs of the one-based height ranger commits at: a massif holds
 * 2^(h-1) leaves (go-merklelog urkle.LeafCountForMassifHeight, mirrored by
 * {@link leafCountForMassifHeight}).
 */

import { leafCountForMassifHeight } from "@forestrie/merklelog";

/**
 * Massifs of sequenced entries kept per log. 4 × 2^(h-1) keeps the
 * 32,768-entry window (h=14) the queue had when it mis-sized massifs as 2^h
 * and kept "2 massifs".
 */
export const RETAINED_MASSIFS = 4;

/**
 * Returns how many sequenced entries behind the newest to retain for a log
 * whose massifs have the given one-based height.
 *
 * @throws RangeError when massifHeight is not a positive integer. Callers
 *   check this before writing, so a bad ack marks nothing sequenced.
 */
export function retainedEntryCount(massifHeight: number): number {
  if (!Number.isInteger(massifHeight) || massifHeight < 1) {
    throw new RangeError(
      `massifHeight must be a positive integer, got ${massifHeight}`,
    );
  }
  return Number(leafCountForMassifHeight(massifHeight)) * RETAINED_MASSIFS;
}
