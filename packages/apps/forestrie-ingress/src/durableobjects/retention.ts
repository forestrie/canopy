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
 * Largest massif height accepted. arbor's ranger configures it as a Go
 * `uint8` and uses 14; above 64 a massif would hold more than 2^63 leaves,
 * and the retention window stops being representable as a number.
 */
export const MAX_MASSIF_HEIGHT = 64;

/**
 * Returns how many sequenced entries behind the newest to retain for a log
 * whose massifs have the given one-based height.
 *
 * @throws RangeError when massifHeight is not an integer in
 *   [1, {@link MAX_MASSIF_HEIGHT}]. Callers
 *   check this before writing, so a bad ack marks nothing sequenced.
 */
export function retainedEntryCount(massifHeight: number): number {
  if (
    !Number.isInteger(massifHeight) ||
    massifHeight < 1 ||
    massifHeight > MAX_MASSIF_HEIGHT
  ) {
    throw new RangeError(
      `massifHeight must be an integer in [1, ${MAX_MASSIF_HEIGHT}], ` +
        `got ${massifHeight}`,
    );
  }
  return Number(leafCountForMassifHeight(massifHeight)) * RETAINED_MASSIFS;
}
