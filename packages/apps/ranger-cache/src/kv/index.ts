/**
 * Cloudflare KV-specific helpers for ranger cache.
 *
 * This module is intentionally small and focused: it knows about KV
 * bindings and key shapes, but nothing about R2_LEAVES or massif formats.
 */

export interface RangerKVNamespace {
  get(key: string): Promise<string | null>;
  put(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

export interface RangerKVBindings {
  mmrIndexKV: RangerKVNamespace;
  mmrCacheKV: RangerKVNamespace;
}

/**
 * Write the latest head index for a given log to the index KV.
 */
export async function writeHeadIndex(
  kv: RangerKVBindings,
  logId: string,
  headIndex: number,
): Promise<void> {
  const key = `logs/${logId}/head`;
  await kv.mmrIndexKV.put(key, JSON.stringify({ index: headIndex }));
}

/**
 * Store a derived massif cache entry. The payload shape is deliberately
 * opaque at this layer so that higher-level ranger logic owns the schema.
 */
export async function writeMassifCacheEntry(
  kv: RangerKVBindings,
  cacheKey: string,
  payload: unknown,
): Promise<void> {
  await kv.mmrCacheKV.put(cacheKey, JSON.stringify(payload));
}
