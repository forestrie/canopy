/**
 * Log "initialized" for register-grant bootstrap branching: the first massif tile exists
 * in R2_MMRS (Ranger / sequenced merklelog v2 layout). Same key shape as resolve-receipt
 * and sequencing-result (massif index 0 → 16-digit decimal segment).
 *
 * Races between "no massif yet" and "first leaf landed" are accepted; duplicate bootstrap
 * grants at sequencing are treated as idempotent.
 */

/** 16-digit decimal segment for R2 object keys (matches checkpoint-from-storage / sequencing-result). */
export function massifIndexToObjectKeySegment(massifIndex: number): string {
  return massifIndex.toString(10).padStart(16, "0");
}

export function firstMassifObjectKey(
  logId: string,
  massifHeight: number,
): string {
  const objectIndex = massifIndexToObjectKeySegment(0);
  return `v2/merklelog/massifs/${massifHeight}/${logId}/${objectIndex}.log`;
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
