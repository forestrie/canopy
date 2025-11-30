/**
 * Ranger cache worker entrypoint.
 *
 * This worker consumes queue notifications that reference changed R2_MMRS
 * objects, reads those objects, and updates KV-backed caches used by
 * the rest of the system.
 */

import type { RangerR2Bucket } from "./r2";
import type { RangerKVBindings, RangerKVNamespace } from "./kv";
import { toR2ObjectReference } from "./r2";
import { processR2ObjectNotification } from "./ranger";

// Minimal execution context surface we rely on.
interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
}

export interface Env {
  R2_MMRS: RangerR2Bucket;
  RANGER_MMR_INDEX: RangerKVNamespace;
  RANGER_MMR_MASSIFS: RangerKVNamespace;
  CANOPY_ID: string;
  FOREST_PROJECT_ID: string;
  NODE_ENV: string;
}

function kvBindingsFromEnv(env: Env): RangerKVBindings {
  return {
    mmrIndexKV: env.RANGER_MMR_INDEX,
    mmrCacheKV: env.RANGER_MMR_MASSIFS,
  };
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

/**
 * Complete R2 event notification structure as sent by Cloudflare.
 *
 * Cloudflare R2 sends event notifications to queues when objects are created
 * or updated. This interface represents the complete notification payload.
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

/**
 * Type guard to check if a value matches the R2Notification structure.
 */
function isR2Notification(body: unknown): body is R2Notification {
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

const worker = {
  async queue(batch: RangerQueueBatch, env: Env, ctx: ExecutionContext) {
    const deps = {
      r2: env.R2_MMRS,
      kv: kvBindingsFromEnv(env),
    };

    for (const message of batch.messages) {
      // Try to parse as typed R2Notification for richer logging
      if (isR2Notification(message.body)) {
        const notification: R2Notification = message.body;
        const obj = notification.object;

        console.log("R2 notification received:", {
          account: notification.account,
          action: notification.action,
          bucket: notification.bucket,
          eventTime: notification.eventTime,
          object: {
            key: obj.key,
            size: obj.size,
            eTag: obj.eTag,
            contentType: obj.contentType ?? "(not provided)",
            lastModified: obj.lastModified ?? "(not provided)",
            customMetadata: obj.customMetadata ?? "(not provided)",
          },
        });
      } else {
        // Fallback: log raw body if it doesn't match expected structure
        console.log(
          "R2 notification received (unexpected format):",
          JSON.stringify(message.body, null, 2),
        );
      }

      const ref = toR2ObjectReference(message.body);
      if (!ref) {
        console.warn(
          "Failed to parse R2 object reference from message body:",
          message.body,
        );
        continue;
      }

      ctx.waitUntil(processR2ObjectNotification(ref, deps));
    }
  },

  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/_ranger-cache/health") {
      return Response.json({
        status: "ok",
        canopyId: env.CANOPY_ID,
        env: env.NODE_ENV,
      });
    }

    return new Response("ranger-cache worker", {
      status: 200,
      headers: { "content-type": "text/plain" },
    });
  },
};

export default worker;
