/**
 * Ranger cache worker entrypoint.
 *
 * This worker consumes queue notifications that reference changed R2_MMRS
 * objects, reads those objects, and updates KV-backed caches used by
 * the rest of the system.
 */

import type { RangerR2Bucket } from "./r2";
import type { RangerKVBindings, RangerKVNamespace, KVBulkEntry } from "./kv";
import { toR2ObjectReference } from "./r2";
import { processR2ObjectNotification } from "./ranger";
import { bulkWriteMMRIndex } from "./kv";
import {
  Massif,
  massifLogEntries,
  mmrIndex,
  massifFirstLeaf,
  LogFormat,
  TrieEntryFmt,
  computeLastMMRIndex,
  isMassifFull,
  readTrieEntry,
  type TrieEntryData,
} from "@canopy/merklelog";

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
  /** Cloudflare API token for REST API bulk writes */
  RANGER_CACHE_WRITER: string;
  /** Cloudflare account ID for REST API bulk writes */
  CLOUDFLARE_ACCOUNT_ID: string;
  /** KV namespace ID for RANGER_MMR_INDEX (for REST API) */
  RANGER_MMR_INDEX_NAMESPACE_ID: string;
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
 * Supports both formats:
 * - Old: v1/mmrs/tenant/{logId}/{massifHeight}/massifs/{massifIndex}.log
 * - New: v2/merklelog/massifs/{massifHeight}/{logId}/{massifIndex}.log
 * - New: v2/merklelog/checkpoints/{massifHeight}/{logId}/{massifIndex}.sth
 *
 * @param key - The object key path from the R2 notification
 * @returns Parsed components including logId, massifHeight, and massifIndex
 * @throws Error if the key doesn't match expected format or if parsing fails
 */
export function parseMassifKey(key: string): ParsedMassifKey {
  const parts = key.split("/");

  // Check for new v2 format: v2/merklelog/massifs/{massifHeight}/{logId}/{index}.log
  // or v2/merklelog/checkpoints/{massifHeight}/{logId}/{index}.sth
  if (parts.length >= 6 && parts[0] === "v2" && parts[1] === "merklelog") {
    const typePart = parts[2]; // "massifs" or "checkpoints"
    const massifHeightStr = parts[3];
    const logId = parts[4];
    const filename = parts[5];

    // Validate extension
    const expectedExt = typePart === "massifs" ? ".log" : ".sth";
    if (!filename.endsWith(expectedExt)) {
      throw new Error(
        `Expected ${expectedExt} extension for ${typePart}, got: ${filename}`,
      );
    }

    // Parse massif index (hex, 16 digits)
    const massifIndexStr = filename.slice(0, -expectedExt.length);
    if (massifIndexStr.length !== 16) {
      throw new Error(
        `Massif index must be 16 hex digits, got ${massifIndexStr.length}: ${massifIndexStr}`,
      );
    }

    const massifIndex = Number.parseInt(massifIndexStr, 16);
    if (!Number.isFinite(massifIndex)) {
      throw new Error(
        `Failed to parse massif index as hex number: ${massifIndexStr}`,
      );
    }

    // Parse massifHeight
    const massifHeight = Number.parseInt(massifHeightStr, 10);
    if (!Number.isFinite(massifHeight)) {
      throw new Error(
        `Failed to parse massif height as number: ${massifHeightStr}`,
      );
    }

    return {
      logId,
      massifHeight,
      massifIndex,
    };
  }

  // Old v1 format: v1/mmrs/tenant/{logId}/{massifHeight}/massifs/{massifIndex}.log
  if (parts.length < 6) {
    throw new Error(
      `Object key must have at least 6 components for v1 format, got ${parts.length}: ${key}`,
    );
  }

  // Check if it's v1 format
  if (parts[0] !== "v1" || parts[1] !== "mmrs" || parts[2] !== "tenant") {
    throw new Error(`Unrecognized path format: ${key}`);
  }

  const lastComponent = parts[parts.length - 1]; // e.g., "0000000000000000.log"
  const secondLast = parts[parts.length - 2]; // e.g., "massifs" (ignored)
  const thirdLast = parts[parts.length - 3]; // e.g., "0" -> massifHeight
  const fourthLast = parts[parts.length - 4]; // e.g., "3062ea57-c184-41d8-bd61-296b02c680d8" -> logId

  // Parse last component: remove .log or .sth suffix and parse as number
  if (!lastComponent.endsWith(".log") && !lastComponent.endsWith(".sth")) {
    throw new Error(
      `Last component must end with .log or .sth, got: ${lastComponent}`,
    );
  }

  const ext = lastComponent.endsWith(".log") ? ".log" : ".sth";
  const massifIndexStr = lastComponent.slice(0, -ext.length);
  if (massifIndexStr.length !== 16) {
    throw new Error(
      `Massif index must be 16 characters after removing ${ext} suffix, got ${massifIndexStr.length}: ${massifIndexStr}`,
    );
  }

  const massifIndex = Number.parseInt(massifIndexStr, 16);
  if (!Number.isFinite(massifIndex)) {
    throw new Error(
      `Failed to parse massif index as hex number: ${massifIndexStr}`,
    );
  }

  // Parse third last component: massifHeight (special case: '0' -> 14 for backward compatibility)
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
 * Build KV entries for bulk write to RANGER_MMR_INDEX.
 *
 * @param parsedKey - Parsed massif key components
 * @param massif - Massif instance
 * @param blobSize - Size of the massif blob in bytes
 * @param lastIndex - Last MMR index in the massif
 * @param isFull - Whether the massif is full
 * @returns Array of KV entries ready for bulk write
 */
function buildKVEntries(
  parsedKey: ParsedMassifKey,
  massif: Massif,
  blobSize: number,
  lastIndex: bigint,
  isFull: boolean,
): KVBulkEntry[] {
  // Convert 1-based height to 0-based height index
  const heightIndex = parsedKey.massifHeight - 1;

  // Calculate number of leaves
  const logEntries = massifLogEntries(blobSize, heightIndex);
  const actualLeaves = (logEntries + 1n) >> 1n;
  const numLeaves = Number(actualLeaves);

  // Pre-allocate entries array for efficiency
  const entries: KVBulkEntry[] = new Array(numLeaves);

  // Calculate number of leaves per massif: f = (m + 1) / 2 where m = (1 << h) - 1
  const m = BigInt((1 << parsedKey.massifHeight) - 1);
  const leavesPerMassif = (m + 1n) >> 1n;
  // First global leaf index in this massif
  const firstGlobalLeafIndex = leavesPerMassif * BigInt(parsedKey.massifIndex);

  // Pre-allocate value buffer once (104 bytes: 8 + 64 + 32)
  const valueBytes = new Uint8Array(104);
  const valueView = new DataView(valueBytes.buffer);

  // Set expiry once (same for all entries in a massif)
  const expiration_ttl = isFull ? 2147483647 : 3600; // ~68 years for full, 1 hour for incomplete

  // Iterate through all leaves
  for (let leafIdx = 0; leafIdx < numLeaves; leafIdx++) {
    // Calculate global leaf index
    const globalLeafIndex = firstGlobalLeafIndex + BigInt(leafIdx);
    const trieData = readTrieEntry(
      massif,
      leafIdx,
      heightIndex,
      globalLeafIndex,
    );

    // Convert extraData1 to hex string for key (efficient single-pass conversion)
    const extraData1Hex = Array.from<number, string>(trieData.extraData1, (b) =>
      b.toString(16).padStart(2, "0"),
    ).join("");

    // Build key based on whether massif is full
    const key = isFull
      ? `${parsedKey.logId}:${trieData.fenceIndex}:${extraData1Hex}`
      : `${parsedKey.logId}:${trieData.fenceIndex}:${extraData1Hex}:${lastIndex}:`;

    // Build value directly in pre-allocated buffer: mmrIndex (8 bytes BE) || trieEntry (64 bytes) || extraData1 (32 bytes)
    valueView.setBigUint64(0, trieData.mmrIndex, false); // false = big-endian
    valueBytes.set(trieData.trieEntry, 8);
    valueBytes.set(trieData.extraData1, 8 + 64);

    // Convert to base64 efficiently - use spread operator for small arrays (104 bytes)
    const value = btoa(String.fromCharCode(...valueBytes));

    entries[leafIdx] = { key, value, expiration_ttl };
  }

  return entries;
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
    // Validate required environment variables for REST API bulk writes
    if (!env.RANGER_CACHE_WRITER) {
      const error = "RANGER_CACHE_WRITER secret is required but not set";
      console.error(error);
      throw new Error(error);
    }
    if (!env.CLOUDFLARE_ACCOUNT_ID) {
      const error = "CLOUDFLARE_ACCOUNT_ID is required but not set";
      console.error(error);
      throw new Error(error);
    }
    if (!env.RANGER_MMR_INDEX_NAMESPACE_ID) {
      const error = "RANGER_MMR_INDEX_NAMESPACE_ID is required but not set";
      console.error(error);
      throw new Error(error);
    }

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
      } catch (error) {
        console.error(
          `Failed to parse object key "${obj.key}":`,
          error instanceof Error ? error.message : String(error),
        );
        continue;
      }

      // Populate the RANGER_MMR_INDEX kv with the mmr index and related information
      try {
        // 1. Fetch massif data from R2
        const r2Object = await deps.r2.get(obj.key);
        if (!r2Object) {
          console.error(`Massif not found in R2: ${obj.key}`);
          continue;
        }

        const massifData = await r2Object.arrayBuffer();
        const massif = new Massif(massifData);

        // 2. Compute last MMR index
        const heightIndex = parsedKey.massifHeight - 1;
        const logEntries = massifLogEntries(obj.size, heightIndex);
        const lastIndex = computeLastMMRIndex(
          parsedKey.massifHeight,
          parsedKey.massifIndex,
          obj.size,
        );

        // 3. Determine if massif is full
        const full = isMassifFull(parsedKey.massifHeight, logEntries);

        // 4. Build KV entries
        const kvEntries = buildKVEntries(
          parsedKey,
          massif,
          obj.size,
          lastIndex,
          full,
        );

        // 5. Bulk write to RANGER_MMR_INDEX
        await bulkWriteMMRIndex(
          deps.kv.mmrIndexKV,
          kvEntries,
          env.RANGER_CACHE_WRITER,
          env.CLOUDFLARE_ACCOUNT_ID,
          env.RANGER_MMR_INDEX_NAMESPACE_ID,
        );
      } catch (error) {
        console.error(
          `Failed to process massif and write to KV for "${obj.key}":`,
          error instanceof Error ? error.message : String(error),
          error instanceof Error ? error.stack : undefined,
        );
        // Continue processing other messages even if this one fails
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
