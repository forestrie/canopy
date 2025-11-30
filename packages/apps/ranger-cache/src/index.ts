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
 * Parsed components from an R2 object key path.
 *
 * Key path format: v1/mmrs/tenant/{logId}/{massifHeight}/massifs/{massifIndex}.log
 */
export interface ParsedMassifKey {
  /** Log ID as a UUID4 string */
  logId: string;
  /** Massif height (1-based). Special case: if the path component is '0', this will be 14 */
  massifHeight: number;
  /** Massif index as a number (from the filename, 16 hex digits) */
  massifIndex: number;
}

/**
 * Parse an R2 object key to extract log ID, massif height, and massif index.
 *
 * Expected key format: v1/mmrs/tenant/{logId}/{massifHeight}/massifs/{massifIndex}.log
 *
 * @param key - The object key path from the R2 notification
 * @returns Parsed components including logId, massifHeight, and massifIndex
 * @throws Error if the key doesn't have at least 4 components or if parsing fails
 */
export function parseMassifKey(key: string): ParsedMassifKey {
  const parts = key.split("/");

  if (parts.length < 4) {
    throw new Error(
      `Object key must have at least 4 components, got ${parts.length}: ${key}`,
    );
  }

  // Get the last 4 components from the end
  const lastComponent = parts[parts.length - 1]; // e.g., "0000000000000000.log"
  const secondLast = parts[parts.length - 2]; // e.g., "massifs" (ignored)
  const thirdLast = parts[parts.length - 3]; // e.g., "0" -> massifHeight
  const fourthLast = parts[parts.length - 4]; // e.g., "3062ea57-c184-41d8-bd61-296b02c680d8" -> logId

  // Parse last component: remove .log suffix and parse as number
  if (!lastComponent.endsWith(".log")) {
    throw new Error(`Last component must end with .log, got: ${lastComponent}`);
  }

  const massifIndexStr = lastComponent.slice(0, -4); // Remove ".log"
  if (massifIndexStr.length !== 16) {
    throw new Error(
      `Massif index must be 16 characters after removing .log suffix, got ${massifIndexStr.length}: ${massifIndexStr}`,
    );
  }

  const massifIndex = Number.parseInt(massifIndexStr, 16);
  if (!Number.isFinite(massifIndex)) {
    throw new Error(
      `Failed to parse massif index as hex number: ${massifIndexStr}`,
    );
  }

  // Parse third last component: massifHeight (special case: '0' -> 14)
  const massifHeight = thirdLast === "0" ? 14 : Number.parseInt(thirdLast, 10);
  if (!Number.isFinite(massifHeight)) {
    throw new Error(`Failed to parse massif height as number: ${thirdLast}`);
  }

  // Fourth last component is the log ID (UUID4)
  const logId = fourthLast;

  return {
    logId,
    massifHeight,
    massifIndex,
  };
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
      if (!isR2Notification(message.body)) {
        console.warn(
          "Unexpected notification, not an R2 object reference",
          message.body,
        );

        continue;
      }

      // Try to parse as typed R2Notification for richer logging
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

      // Parse the object key to extract log ID, massif height, and massif index
      let parsedKey: ParsedMassifKey;
      try {
        parsedKey = parseMassifKey(obj.key);
        console.log("Parsed massif key:", parsedKey);
      } catch (error) {
        console.error(
          `Failed to parse object key "${obj.key}":`,
          error instanceof Error ? error.message : String(error),
        );
        continue;
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
