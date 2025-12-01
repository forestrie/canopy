/**
 * Cloudflare KV-specific helpers for ranger cache.
 *
 * This module is intentionally small and focused: it knows about KV
 * bindings and key shapes, but nothing about R2_MMRS or massif formats.
 */

export interface RangerKVNamespace {
  get(key: string): Promise<string | null>;
  put(
    key: string,
    value: string,
    options?: { expirationTtl?: number },
  ): Promise<void>;
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

/**
 * KV entry for bulk write operations.
 */
export interface KVBulkEntry {
  key: string;
  value: string;
  expiration_ttl?: number;
}

/**
 * Bulk write entries to KV namespace using Cloudflare REST API.
 *
 * @param apiToken - Cloudflare API token
 * @param accountId - Cloudflare account ID
 * @param namespaceId - KV namespace ID
 * @param entries - Array of key-value entries to write (already in correct format)
 * @throws Error if the API request fails
 */
async function bulkWriteMMRIndexREST(
  apiToken: string,
  accountId: string,
  namespaceId: string,
  entries: KVBulkEntry[],
): Promise<void> {
  const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/storage/kv/namespaces/${namespaceId}/bulk`;

  // Entries already match the required format, serialize directly without transformation
  const response = await fetch(url, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${apiToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(entries),
  });

  // Read response body once
  const responseText = await response.text().catch(() => "Unknown error");

  if (!response.ok) {
    throw new Error(
      `Cloudflare KV REST API bulk write failed: ${response.status} ${response.statusText}. ${responseText}`,
    );
  }

  // Check for API-level errors in response
  let result: {
    success?: boolean;
    errors?: Array<{ message?: string; code?: number }>;
  } | null = null;
  try {
    result = JSON.parse(responseText);
  } catch {
    // If JSON parsing fails, assume success (response was ok and not JSON)
    return;
  }

  if (result && !result.success) {
    const errors = result.errors || [];
    const errorMessages = errors
      .map(
        (e: { message?: string; code?: number }) => `${e.code}: ${e.message}`,
      )
      .join(", ");
    throw new Error(
      `Cloudflare KV REST API bulk write failed: ${errorMessages || "Unknown API error"}`,
    );
  }
}

/**
 * Bulk write entries to a KV namespace using Cloudflare REST API.
 *
 * @param kv - KV namespace binding (unused, kept for interface compatibility)
 * @param entries - Array of key-value entries to write
 * @param apiToken - Cloudflare API token for REST API
 * @param accountId - Cloudflare account ID for REST API
 * @param namespaceId - KV namespace ID for REST API
 * @throws Error if the API request fails
 */
export async function bulkWriteMMRIndex(
  kv: RangerKVNamespace,
  entries: KVBulkEntry[],
  apiToken: string,
  accountId: string,
  namespaceId: string,
): Promise<void> {
  await bulkWriteMMRIndexREST(apiToken, accountId, namespaceId, entries);
  console.log(`Successfully wrote ${entries.length} entries via REST API`);
}
