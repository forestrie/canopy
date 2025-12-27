/**
 * R2 event notification message structure.
 *
 * Cloudflare R2 sends event notifications to queues when objects are created
 * or updated. The notification body contains the R2Notification structure with
 * the following guaranteed fields:
 * - account: Cloudflare account ID
 * - action: Event action type (e.g., "PutObject", "DeleteObject")
 * - bucket: Name of the R2 bucket where the event occurred
 * - object.key: Object key (path) within the bucket
 * - object.size: Object size in bytes
 * - object.eTag: Entity tag (ETag) representing the object version
 * - eventTime: ISO 8601 timestamp when the event occurred
 *
 * Additional optional fields that may be present:
 * - object.contentType: MIME type of the object
 * - object.lastModified: Last modified timestamp (may be same as eventTime)
 * - object.customMetadata: User-defined metadata associated with the object
 */
export interface RangerQueueMessage {
  /**
   * The raw notification body from R2. This is the complete R2 event notification
   * payload as sent by Cloudflare. The body should match the R2Notification structure.
   * Use type assertion or validation to access typed fields: `body as R2Notification`
   */
  body: unknown;
}

export interface RangerQueueBatch {
  messages: RangerQueueMessage[];
}
