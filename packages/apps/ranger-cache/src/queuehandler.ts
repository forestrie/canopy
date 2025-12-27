/**
 * Queue handler for processing R2 massif notifications.
 *
 * When a massif blob is updated in R2, this handler:
 * 1. Parses the notification to extract log ID and massif metadata
 * 2. Fetches the massif blob from R2
 * 3. Passes the raw massif data to the DO for efficient leaf enumeration
 */
import { parseV2StorageObjectPath } from "@canopy/merklelog";
import type { Env } from "./env.js";
import type { RangerQueueBatch } from "./rangerqueue.js";
import { isR2Notification, type R2Notification } from "./r2notification.js";

/**
 * Execution context interface (subset we need).
 */
interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
}

/**
 * Handle a batch of queue messages.
 *
 * Processes R2 notifications and updates the appropriate Durable Objects.
 */
export async function handleQueue(
  batch: RangerQueueBatch,
  env: Env,
  ctx: ExecutionContext,
): Promise<void> {
  for (const message of batch.messages) {
    if (!isR2Notification(message.body)) {
      console.warn(
        "Unexpected notification, not an R2 object reference",
        message.body,
      );
      continue;
    }

    const notification = message.body;

    // Only process PutObject actions (new/updated massifs)
    if (notification.action !== "PutObject") {
      console.log(
        `Skipping ${notification.action} action for ${notification.object.key}`,
      );
      continue;
    }

    // Process in background to avoid blocking queue acknowledgment
    ctx.waitUntil(
      processNotification(notification, env).catch((error) => {
        console.error(
          `Failed to process notification for ${notification.object.key}:`,
          error instanceof Error ? error.message : String(error),
          error instanceof Error ? error.stack : undefined,
        );
      }),
    );
  }
}

// --- Helper functions ---

/**
 * Process a single R2 notification.
 */
async function processNotification(
  notification: R2Notification,
  env: Env,
): Promise<void> {
  const objectKey = notification.object.key;

  // Parse the object key to extract log metadata
  let parsed: ReturnType<typeof parseV2StorageObjectPath>;
  try {
    parsed = parseV2StorageObjectPath(objectKey);
  } catch (error) {
    console.warn(
      `Skipping non-massif object: ${objectKey}`,
      error instanceof Error ? error.message : String(error),
    );
    return;
  }

  const { logId, massifHeight, massifIndex } = parsed;

  console.log("Processing massif notification", {
    logId,
    massifHeight,
    massifIndex,
    objectKey,
  });

  // Fetch the massif blob from R2
  const r2Object = await env.R2_MMRS.get(objectKey);
  if (!r2Object) {
    console.error(`Massif not found in R2: ${objectKey}`);
    return;
  }

  const massifData = await r2Object.arrayBuffer();

  // Get the Durable Object stub for this log
  const doId = env.SEQUENCED_CONTENT.idFromName(deriveDoId(logId));
  const stub = env.SEQUENCED_CONTENT.get(doId);

  // Pass raw massif data to DO for efficient leaf enumeration and upsert
  const result = await stub.batchUpsertFromMassif(
    massifData,
    massifHeight,
    massifIndex,
  );

  console.log("Upserted sequence records", {
    logId,
    objectKey,
    rowsWritten: result.count,
  });
}

/**
 * Derive the Durable Object ID for a given log.
 *
 * Format: "{logId}/rangersequence"
 */
function deriveDoId(logId: string): string {
  return `${logId}/rangersequence`;
}
