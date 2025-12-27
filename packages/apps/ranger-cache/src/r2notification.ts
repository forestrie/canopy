/**
 * R2 event notification types and type guard.
 *
 * Cloudflare R2 sends event notifications to queues when objects are created
 * or updated.
 */

/**
 * Type guard to check if a value matches the R2Notification structure.
 */
export function isR2Notification(body: unknown): body is R2Notification {
  if (
    typeof body !== "object" ||
    body === null ||
    !("object" in body) ||
    typeof (body as any).object !== "object" ||
    (body as any).object === null
  ) {
    return false;
  }

  const obj = body as any;
  const notificationObj = obj.object;

  return (
    typeof obj.account === "string" &&
    typeof obj.action === "string" &&
    typeof obj.bucket === "string" &&
    typeof obj.eventTime === "string" &&
    typeof notificationObj.key === "string" &&
    typeof notificationObj.size === "number" &&
    typeof notificationObj.eTag === "string"
  );
}

// --- Type definitions ---

/**
 * Complete R2 event notification structure as sent by Cloudflare.
 */
export interface R2Notification {
  /** Cloudflare account ID */
  account: string;
  /** Event action type (e.g., "PutObject", "DeleteObject", "CopyObject") */
  action: string;
  /** Name of the R2 bucket where the event occurred */
  bucket: string;
  /** Object metadata including key, size, eTag, and optional fields */
  object: R2NotificationObject;
  /** ISO 8601 timestamp when the event occurred */
  eventTime: string;
}

/**
 * R2 object metadata as provided in event notifications.
 */
export interface R2NotificationObject {
  /** Object key (path) within the bucket */
  key: string;
  /** Object size in bytes */
  size: number;
  /** Entity tag (ETag) representing the object version */
  eTag: string;
  /** MIME type of the object (if available) */
  contentType?: string;
  /** Last modified timestamp (if available) */
  lastModified?: string;
  /** Custom metadata associated with the object (if available) */
  customMetadata?: Record<string, string>;
}
