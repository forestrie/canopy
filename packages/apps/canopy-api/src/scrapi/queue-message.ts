/**
 * Queue message types for Ranger service integration
 *
 * Defines the message schema sent to Cloudflare Queue for processing by ranger
 */

/**
 * Message sent to queue when a new statement is registered in R2
 *
 * This message is consumed by the ranger service which sequences the statement
 * into the transparency log.
 */
export interface LeafRegistrationMessage {
  /** The log identifier (UUID) */
  logId: string;

  /** The fence MMR index assigned to this statement */
  fenceIndex: number;

  /** The storage path in R2 (content-addressed) */
  path: string;

  /** The MD5 hash of the content (hex) */
  hash: string;

  /** The ETag returned by R2 (used for integrity verification) */
  etag: string;

  /** Timestamp when the statement was registered (ISO 8601) */
  timestamp: string;

  /** The canopy ID that registered this statement */
  canopyId: string;

  /** The forest project ID */
  forestProjectId: string;
}

/**
 * Create a queue message for a newly registered leaf
 */
export function createLeafRegistrationMessage(
  logId: string,
  fenceIndex: number,
  path: string,
  hash: string,
  etag: string,
  canopyId: string,
  forestProjectId: string,
): LeafRegistrationMessage {
  return {
    logId,
    fenceIndex,
    path,
    hash,
    etag,
    timestamp: new Date().toISOString(),
    canopyId,
    forestProjectId,
  };
}
