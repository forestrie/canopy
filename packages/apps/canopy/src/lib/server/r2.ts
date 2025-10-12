/**
 * R2 Storage utilities for SCITT/SCRAPI statements
 */
import { createHash } from 'crypto';
import type { R2Bucket, R2Object } from '@cloudflare/workers-types';

export interface StatementMetadata {
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
	// Calculate MD5 hash of content
	const hash = await calculateMD5(content);

	// Build the content-addressed path
	const path = buildStatementPath(logId, fenceIndex, hash);

	// Prepare metadata
	const metadata: StatementMetadata = {
		logId,
		fenceIndex,
		contentHash: hash,
		contentType,
		timestamp: Date.now(),
		sequenced: false
	};

	// Store in R2 with content hash as ETag
	const result = await bucket.put(path, content, {
		httpMetadata: {
			contentType,
			cacheControl: 'public, max-age=31536000, immutable' // Content-addressed, can cache forever
		},
		customMetadata: metadata as any,
		md5: hash
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
export async function getStatement(
	bucket: R2Bucket,
	path: string
): Promise<{ content: ArrayBuffer; metadata: StatementMetadata } | null> {
	const object = await bucket.get(path);
	if (!object) return null;

	const content = await object.arrayBuffer();
	const metadata = object.customMetadata as unknown as StatementMetadata;

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
export function buildStatementPath(
	logId: string,
	fenceIndex: number,
	contentHash: string
): string {
	return `logs/${logId}/leaves/${fenceIndex}/${contentHash}`;
}

/**
 * Calculate MD5 hash of content
 *
 * @param content The content to hash
 * @returns The hex-encoded MD5 hash
 */
async function calculateMD5(content: ArrayBuffer): Promise<string> {
	// Use Web Crypto API for MD5 (note: MD5 is used for content addressing, not security)
	// In Cloudflare Workers, we'll use the crypto global
	const hashBuffer = await crypto.subtle.digest('MD5', content);
	const hashArray = Array.from(new Uint8Array(hashBuffer));
	const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
	return hashHex;
}

/**
 * List statements for a given log
 *
 * @param bucket The R2 bucket
 * @param logId The log identifier
 * @param limit Maximum number of results
 * @param cursor Pagination cursor
 * @returns List of statement paths and metadata
 */
export async function listStatements(
	bucket: R2Bucket,
	logId: string,
	limit: number = 100,
	cursor?: string
): Promise<{ statements: R2Object[]; cursor?: string }> {
	const prefix = `logs/${logId}/leaves/`;
	const result = await bucket.list({
		prefix,
		limit,
		cursor
	});

	return {
		statements: result.objects,
		cursor: result.truncated ? result.cursor : undefined
	};
}