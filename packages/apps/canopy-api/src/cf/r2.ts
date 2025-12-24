/**
 * R2_LEAVES Storage utilities for SCITT/SCRAPI statements
 */

export interface LeafObjectMetadata {
  logId: string;
  contentType: string;
  appId: string;
}

/**
 * Store a statement in R2_LEAVES with content-addressed path
 *
 * @param bucket The R2_LEAVES bucket
 * @param logId The log identifier (UUID)
 * @param content The statement content (CBOR/COSE)
 * @param contentType The MIME type of the content
 * @returns The storage result with path and hash
 */
export async function storeLeaf(
  bucket: R2Bucket,
  logId: string,
  content: ArrayBuffer,
  contentType: string = "application/cbor",
): Promise<{ path: string; hash: string; etag: string }> {
  // Calculate SHA256 hash for content addressing
  const hash = await calculateSHA256(content);

  // Build the content-addressed path
  const path = buildLeafPath(logId, hash);

  // Convert ArrayBuffer to Uint8Array for R2_LEAVES/Miniflare compatibility
  // This fixes the serialization issue with Miniflare
  const uint8Content = new Uint8Array(content);

  // Store in R2_LEAVES - hash is in path, not stored separately
  //
  // IMPORTANT: this write is intentionally CREATE-ONLY.
  //
  // SCRAPI allows pre-sequence identifiers to be transient and expirable. In
  // Forestrie, the content hash is used as the temporary id within a bounded
  // sequencing window defined by ingress lifecycle/expiry policy.
  //
  // - While the object exists at this key, re-registering identical content is
  //   idempotent (no duplicate sequencing, no new queue notification).
  // - After the object expires and is removed, re-registering the same content
  //   will create a new ingress object and may sequence again. In that case,
  //   the same temporary id (content hash) will intentionally resolve to the
  //   most recent registration.
  let result: R2Object | null;
  try {
    result = await bucket.put(path, uint8Content, {
      httpMetadata: {
        contentType,
        cacheControl: "public, max-age=31536000, immutable", // Content-addressed, can cache forever
      },
      // R2_LEAVES customMetadata must be string values
      // Note: hash is NOT stored in metadata - path is authoritative
      customMetadata: {
        logId: logId,
        contentType: contentType,
        appId: path,
      } as Record<string, string>,
      // Removed md5 option - R2_LEAVES's md5 expects MD5 format, we use SHA256 in path
      onlyIf: {
        // Create-only: fail if the object already exists.
        etagDoesNotMatch: "*",
      },
    });
    // If create-only fails, R2 returns null. Treat as idempotent success.
    if (!result) {
      const head = await bucket.head(path);
      if (!head) {
        throw new Error(
          "Create-only put returned null but object is not present on head()",
        );
      }
      result = head;
    }
  } catch (error) {
    console.error("Error storing leaf in R2_LEAVES:", error);
    throw error;
  }

  return {
    path,
    hash,
    etag: result.etag,
  };
}

/**
 * Retrieve a statement from R2_LEAVES
 *
 * @param bucket The R2_LEAVES bucket
 * @param path The statement path
 * @returns The statement content and metadata
 */
export async function getLeafObject(
  bucket: R2Bucket,
  path: string,
): Promise<{ content: ArrayBuffer; metadata: LeafObjectMetadata } | null> {
  const object = await bucket.get(path);
  if (!object) return null;

  const content = await object.arrayBuffer();
  const md = (object.customMetadata || {}) as Record<string, string>;
  const metadata: LeafObjectMetadata = {
    logId: md.logId || "",
    contentType: md.contentType || "",
    appId: md.appId || "",
  };

  return { content, metadata };
}

/**
 * Build the content-addressed storage path
 * Format: /logs/<LOG_ID>/leaves/{SHA256_CONTENT_DIGEST}
 *
 * @param logId The log identifier
 * @param contentHash The SHA256 hash of the content (64 hex characters)
 * @returns The storage path
 */
export function buildLeafPath(logId: string, contentHash: string): string {
  return `logs/${logId}/leaves/${contentHash}`;
}

/**
 * Calculate SHA256 hash of content
 * Uses Web Crypto API (available in Cloudflare Workers)
 *
 * @param content The content to hash
 * @returns The hex-encoded SHA256 hash (64 hex characters)
 */
async function calculateSHA256(content: ArrayBuffer): Promise<string> {
  const hashBuffer = await crypto.subtle.digest("SHA-256", content);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const hashHex = hashArray
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return hashHex;
}

/**
 * List leaves (statements) for a log.
 */
export async function listLeaves(
  bucket: R2Bucket,
  logId: string,
  limit: number = 100,
  cursor?: string,
): Promise<{ objects: R2Object[]; cursor?: string }> {
  const prefix = `logs/${logId}/leaves/`;

  const result = await bucket.list({
    prefix,
    limit,
    cursor,
  });

  return {
    objects: result.objects,
    cursor: result.truncated ? result.cursor : undefined,
  };
}

/**
 * Count total leaves for a log.
 */
export async function countLeaves(
  bucket: R2Bucket,
  logId: string,
): Promise<number> {
  const prefix = `logs/${logId}/leaves/`;

  let total = 0;
  let cursor: string | undefined;

  do {
    const result = await bucket.list({
      prefix,
      limit: 1000,
      cursor,
    });

    total += result.objects.length;
    cursor = result.truncated ? result.cursor : undefined;
  } while (cursor);

  return total;
}

export interface DeleteExpiredLeavesResult {
  scanned: number;
  deleted: number;
  timedOut: boolean;
}

export interface DeleteExpiredLeavesOptions {
  /**
   * Prefix to scan. Defaults to `logs/`.
   *
   * Note: We further filter keys to those containing `/leaves/` to avoid deleting other R2 data.
   */
  prefix?: string;
  /** Max number of objects to fetch per list page. Defaults to 1000. */
  listLimit?: number;
  /** Max number of keys to send per delete call. Defaults to 1000. */
  deleteBatchSize?: number;
  /**
   * Soft time budget for the sweep. When exceeded, we stop scanning further pages.
   * Defaults to 10 seconds.
   */
  timeBudgetMs?: number;
  /**
   * Override "now" for testing/determinism (milliseconds since epoch).
   * Defaults to Date.now() at the start of the sweep.
   */
  now?: number;
}

/**
 * Best-effort expiry for transient ingress leaves.
 *
 * Cloudflare R2's built-in lifecycle rules are bucket-level and not suitable for
 * minute-level TTL (and are not configurable via `wrangler.jsonc`). We implement
 * a scheduled sweep that deletes leaf objects older than a given TTL.
 */
export async function deleteExpiredLeaves(
  bucket: R2Bucket,
  ttlSeconds: number,
  options: DeleteExpiredLeavesOptions = {},
): Promise<DeleteExpiredLeavesResult> {
  if (!Number.isFinite(ttlSeconds) || ttlSeconds <= 0) {
    return { scanned: 0, deleted: 0, timedOut: false };
  }

  const prefix = options.prefix ?? "logs/";
  const listLimit = options.listLimit ?? 1000;
  const deleteBatchSize = options.deleteBatchSize ?? 1000;
  const timeBudgetMs = options.timeBudgetMs ?? 10_000;

  const startTime = Date.now();
  const now = options.now ?? startTime;
  const ttlMs = ttlSeconds * 1000;

  let scanned = 0;
  let deleted = 0;
  let timedOut = false;

  let cursor: string | undefined;
  let toDelete: string[] = [];

  const flushDeletes = async () => {
    if (toDelete.length === 0) return;
    const batch = toDelete;
    toDelete = [];
    await bucket.delete(batch);
    deleted += batch.length;
  };

  while (true) {
    const result = await bucket.list({
      prefix,
      limit: listLimit,
      cursor,
    });

    for (const obj of result.objects) {
      scanned += 1;

      // Defensive: only delete leaf objects under the expected keyspace.
      if (!obj.key.includes("/leaves/")) continue;

      const uploadedMs = obj.uploaded.getTime();
      const ageMs = now - uploadedMs;
      if (ageMs < ttlMs) continue;

      toDelete.push(obj.key);

      if (toDelete.length >= deleteBatchSize) {
        await flushDeletes();
      }
    }

    if (Date.now() - startTime > timeBudgetMs) {
      timedOut = true;
      break;
    }

    if (!result.truncated) break;
    cursor = result.cursor;
  }

  await flushDeletes();

  return { scanned, deleted, timedOut };
}
