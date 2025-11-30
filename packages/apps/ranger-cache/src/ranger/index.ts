import type { R2ObjectReference, RangerR2Bucket } from "../r2";
import type { RangerKVBindings } from "../kv";
import { writeHeadIndex, writeMassifCacheEntry } from "../kv";
import { deriveMassifCacheKey, parseMassifCoordinateFromKey } from "../massifs";

export interface RangerDependencies {
  r2: RangerR2Bucket;
  kv: RangerKVBindings;
}

/**
 * Core ranger orchestration logic.
 *
 * Given a reference to an R2_MMRS object that has changed, this function is
 * responsible for updating the KV-backed caches. The implementation is
 * intentionally minimal for now and focuses on wiring and testability.
 */
export async function processR2ObjectNotification(
  ref: R2ObjectReference,
  deps: RangerDependencies,
): Promise<{ cacheKey?: string }> {
  const coordinate = parseMassifCoordinateFromKey(ref.key);
  if (!coordinate) {
    // Unknown object layout – nothing to cache yet.
    return {};
  }

  const cacheKey = deriveMassifCacheKey(coordinate);

  // Placeholder behaviour: write a minimal head index and cache entry.
  await writeHeadIndex(deps.kv, coordinate.logId, coordinate.index);
  await writeMassifCacheEntry(deps.kv, cacheKey, {
    sourceKey: ref.key,
  });

  return { cacheKey };
}
