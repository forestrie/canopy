/**
 * R2 Storage utilities for SCITT/SCRAPI statements
 */
import type { R2Bucket, R2Object } from '@cloudflare/workers-types';
import SparkMD5 from 'spark-md5';

export interface LeafObjectMetadata {
  logId: string;
  fenceIndex: number;
  contentHash: string;
  contentType: string;
  timestamp: number;
  sequenced: boolean;
  sequencerIndex?: number;
}

/**
 * Store a statement in R2 with content-addressed path
 *
 * @param bucket The R2 bucket
 * @param logId The log identifier (UUID)
 * @param fenceIndex The fence MMR index
 * @param content The statement content (CBOR/COSE)
 * @param contentType The MIME type of the content
 * @returns The storage result with path and hash
 */
export async function storeStatement(
  bucket: R2Bucket,
  logId: string,
  fenceIndex: number,
  content: ArrayBuffer,
  contentType: string = 'application/cbor'
): Promise<{ path: string; hash: string; etag: string }> {
  // Calculate MD5 hash (hex for identity + raw digest for R2 integrity header)
  const { hex: hash, raw } = await calculateMD5(content);

  // Build the content-addressed path
  const path = buildLeafPath(logId, fenceIndex, hash);

  // Prepare metadata
  const meta: LeafObjectMetadata = {
    logId,
    fenceIndex,
    contentHash: hash,
    contentType,
    timestamp: Date.now(),
    sequenced: false
  };

  // Convert ArrayBuffer to Uint8Array for R2/Miniflare compatibility
  // This fixes the serialization issue with Miniflare
  const uint8Content = new Uint8Array(content);

  // Store in R2 with content hash as ETag
  const result = await bucket.put(path, uint8Content as unknown as BodyInit, {
    httpMetadata: {
      contentType,
      cacheControl: 'public, max-age=31536000, immutable' // Content-addressed, can cache forever
    },
    // R2 customMetadata must be string values
    customMetadata: {
      logId: meta.logId,
      fenceIndex: String(meta.fenceIndex),
      contentHash: meta.contentHash,
      contentType: meta.contentType,
      timestamp: String(meta.timestamp),
      sequenced: String(meta.sequenced)
    } as Record<string, string>,
    // Convert raw MD5 to base64 string for R2 (Miniflare compatible)
    md5: btoa(String.fromCharCode(...new Uint8Array(raw)))
  });

  return {
    path,
    hash,
    etag: result.etag
  };
}

/**
 * Retrieve a statement from R2
 *
 * @param bucket The R2 bucket
 * @param path The statement path
 * @returns The statement content and metadata
 */
export async function getLeafObject(
  bucket: R2Bucket,
  path: string
): Promise<{ content: ArrayBuffer; metadata: LeafObjectMetadata } | null> {
  const object = await bucket.get(path);
  if (!object) return null;

  const content = await object.arrayBuffer();
  const md = (object.customMetadata || {}) as Record<string, string>;
  const metadata: LeafObjectMetadata = {
    logId: md.logId,
    fenceIndex: Number(md.fenceIndex || 0),
    contentHash: md.contentHash,
    contentType: md.contentType,
    timestamp: Number(md.timestamp || Date.now()),
    sequenced: md.sequenced === 'true',
    sequencerIndex: md.sequencerIndex ? Number(md.sequencerIndex) : undefined
  };

  return { content, metadata };
}

/**
 * Build the content-addressed storage path
 * Format: /logs/<LOG_ID>/leaves/{FENCE_MMRINDEX}/{MD5_CONTENT_DIGEST}
 *
 * @param logId The log identifier
 * @param fenceIndex The fence MMR index
 * @param contentHash The MD5 hash of the content
 * @returns The storage path
 */
export function buildLeafPath(
  logId: string,
  fenceIndex: number,
  contentHash: string
): string {
  return `logs/${logId}/leaves/${fenceIndex}/${contentHash}`;
}

/**
 * Calculate MD5 hash of content
 * Note: MD5 is used for content addressing, NOT for security
 *
 * @param content The content to hash
 * @returns The hex-encoded MD5 hash and raw buffer
 */
async function calculateMD5(content: ArrayBuffer): Promise<{ hex: string; raw: ArrayBuffer }> {
  // Use spark-md5 which works in both Node.js and Cloudflare Workers
  const spark = new SparkMD5.ArrayBuffer();
  spark.append(content);
  const hashHex = spark.end();
  const hashRaw = spark.end(true);

  // Convert hex string to ArrayBuffer for the raw value
  const md5Raw = new Uint8Array(16);
  for (let i = 0; i < 16; i++) {
    // md5Raw[i] = parseInt(hashHex.substr(i * 2, 2), 16);
    md5Raw[i] =  hashRaw.charCodeAt(i);
  }

  return { hex: hashHex, raw: md5Raw.buffer };
}

/**
 * List leaves (statements) for a log, optionally filtered by fence index
 */
export async function listLeaves(
  bucket: R2Bucket,
  logId: string,
  fenceIndex?: number,
  limit: number = 100,
  cursor?: string
): Promise<{ objects: R2Object[]; cursor?: string }> {
  const prefix = fenceIndex !== undefined
    ? `logs/${logId}/leaves/${fenceIndex}/`
    : `logs/${logId}/leaves/`;

  const result = await bucket.list({
    prefix,
    limit,
    cursor
  });

  return {
    objects: result.objects,
    cursor: result.truncated ? result.cursor : undefined
  };
}

/**
 * Count total leaves for a log, optionally filtered by fence index
 */
export async function countLeaves(
  bucket: R2Bucket,
  logId: string,
  fenceIndex?: number
): Promise<number> {
  const prefix = fenceIndex !== undefined
    ? `logs/${logId}/leaves/${fenceIndex}/`
    : `logs/${logId}/leaves/`;

  let total = 0;
  let cursor: string | undefined;

  do {
    const result = await bucket.list({
      prefix,
      limit: 1000,
      cursor
    });

    total += result.objects.length;
    cursor = result.truncated ? result.cursor : undefined;
  } while (cursor);

  return total;
}

/**
 * Alias for storeStatement - stores a leaf in R2
 * This is the preferred name for SCRAPI modules
 */
export const storeLeaf = storeStatement;
