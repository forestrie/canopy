/**
 * R2_LEAVES Storage utilities for SCITT/SCRAPI statements
 */

export interface LeafObjectMetadata {
  logId: string;
  fenceIndex: number;
  contentType: string;
  timestamp: number;
  sequenced: boolean;
  sequencerIndex?: number;
}

/**
 * Store a statement in R2_LEAVES with content-addressed path
 *
 * @param bucket The R2_LEAVES bucket
 * @param logId The log identifier (UUID)
 * @param fenceIndex The fence MMR index
 * @param content The statement content (CBOR/COSE)
 * @param contentType The MIME type of the content
 * @returns The storage result with path and hash
 */
export async function storeLeaf(
  bucket: R2Bucket,
  logId: string,
  fenceIndex: number,
  content: ArrayBuffer,
  contentType: string = "application/cbor",
): Promise<{ path: string; hash: string; etag: string }> {
  // Calculate SHA256 hash for content addressing
  const hash = await calculateSHA256(content);

  // Build the content-addressed path
  const path = buildLeafPath(logId, fenceIndex, hash);

  // Prepare metadata
  const meta: LeafObjectMetadata = {
    logId,
    fenceIndex,
    contentType,
    timestamp: Date.now(),
    sequenced: false,
  };

  // Convert ArrayBuffer to Uint8Array for R2_LEAVES/Miniflare compatibility
  // This fixes the serialization issue with Miniflare
  const uint8Content = new Uint8Array(content);

  // Store in R2_LEAVES - hash is in path, not stored separately
  let result;
  try {
    result = await bucket.put(path, uint8Content, {
      httpMetadata: {
        contentType,
        cacheControl: "public, max-age=31536000, immutable", // Content-addressed, can cache forever
      },
      // R2_LEAVES customMetadata must be string values
      // Note: hash is NOT stored in metadata - path is authoritative
      customMetadata: {
        logId: meta.logId,
        fenceIndex: String(meta.fenceIndex),
        contentType: meta.contentType,
        timestamp: String(meta.timestamp),
        sequenced: String(meta.sequenced),
      } as Record<string, string>,
      // Removed md5 option - R2_LEAVES's md5 expects MD5 format, we use SHA256 in path
    });
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
    logId: md.logId,
    fenceIndex: Number(md.fenceIndex || 0),
    contentType: md.contentType,
    timestamp: Number(md.timestamp || Date.now()),
    sequenced: md.sequenced === "true",
    sequencerIndex: md.sequencerIndex ? Number(md.sequencerIndex) : undefined,
  };

  return { content, metadata };
}

/**
 * Build the content-addressed storage path
 * Format: /logs/<LOG_ID>/leaves/{FENCE_MMRINDEX}/{SHA256_CONTENT_DIGEST}
 *
 * @param logId The log identifier
 * @param fenceIndex The fence MMR index
 * @param contentHash The SHA256 hash of the content (64 hex characters)
 * @returns The storage path
 */
export function buildLeafPath(
  logId: string,
  fenceIndex: number,
  contentHash: string,
): string {
  return `logs/${logId}/leaves/${fenceIndex}/${contentHash}`;
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
 * List leaves (statements) for a log, optionally filtered by fence index
 */
export async function listLeaves(
  bucket: R2Bucket,
  logId: string,
  fenceIndex?: number,
  limit: number = 100,
  cursor?: string,
): Promise<{ objects: R2Object[]; cursor?: string }> {
  const prefix =
    fenceIndex !== undefined
      ? `logs/${logId}/leaves/${fenceIndex}/`
      : `logs/${logId}/leaves/`;

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
 * Count total leaves for a log, optionally filtered by fence index
 */
export async function countLeaves(
  bucket: R2Bucket,
  logId: string,
  fenceIndex?: number,
): Promise<number> {
  const prefix =
    fenceIndex !== undefined
      ? `logs/${logId}/leaves/${fenceIndex}/`
      : `logs/${logId}/leaves/`;

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
