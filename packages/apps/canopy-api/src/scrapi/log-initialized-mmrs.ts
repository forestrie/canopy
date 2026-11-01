import { v2MassifObjectKey } from "@forestrie/merklelog";

/**
 * Log "initialized" for register-grant bootstrap branching: the first massif tile exists
 * in R2_MMRS (Ranger / sequenced merklelog v2 layout). Key built by
 * {@link v2MassifObjectKey} (`@forestrie/merklelog`), shared with resolve-receipt and
 * sequencing-result.
 *
 * Races between "no massif yet" and "first leaf landed" are accepted; duplicate bootstrap
 * grants at sequencing are treated as idempotent.
 */

/** R2 key of the first massif (index 0) `.log` object for a log. */
export function firstMassifObjectKey(
  logId: string,
  massifHeight: number,
): string {
  return v2MassifObjectKey(massifHeight, logId, 0n);
}

/**
 * True when the first massif `.log` object exists for this logId and massif height.
 * @throws R2 or runtime errors from `head` — callers should fail closed (e.g. 503).
 */
export async function isLogInitializedMmrs(
  logId: string,
  r2Mmrs: R2Bucket,
  massifHeight: number,
): Promise<boolean> {
  const key = firstMassifObjectKey(logId, massifHeight);
  const head = await r2Mmrs.head(key);
  return head !== null;
}
