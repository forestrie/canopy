/**
 * Query Registration Status operation (SCRAPI 2.1.3) for Forestrie.
 *
 * Forestrie uses the statement content hash as the transient SCRAPI identifier.
 * This endpoint resolves that transient id to a permanent identifier once
 * sequencing is complete, by consulting the SequencingQueue Durable Object.
 *
 * On cache hit, reads the idtimestamp from the massif using an efficient
 * byte-range request.
 *
 * See: arbor/docs/arc-cloudflare-do-ingress.md section 3.12
 */

import type { SequencingQueueStub } from "@canopy/forestrie-ingress-types";
import { shardNameForLog } from "@canopy/forestrie-sharding";
import { seeOtherResponse } from "./cbor-response";
import { ClientErrors, ServerErrors } from "./problem-details";
import { encodeEntryId } from "./entry-id";
import {
  mmrIndexFromLeafIndex,
  readIdtimestampFromMassif,
} from "./sequencing-result.js";

function isUuid(id: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    id,
  );
}

function isSha256Hex(id: string): boolean {
  return /^[0-9a-f]{64}$/i.test(id);
}

/**
 * Convert a hex string to an ArrayBuffer.
 */
function hexToBuffer(hex: string): ArrayBuffer {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
  }
  return bytes.buffer;
}

/**
 * Durable Object namespace interface for type safety.
 */
interface SequencingQueueNamespace {
  idFromName(name: string): DurableObjectId;
  get(id: DurableObjectId): SequencingQueueStub;
}

/**
 * Parse shard count from environment string.
 */
function getShardCount(shardCountStr: string): number {
  const count = parseInt(shardCountStr, 10);
  if (isNaN(count) || count < 1) {
    console.error(`Invalid QUEUE_SHARD_COUNT: ${shardCountStr}, using 1`);
    return 1;
  }
  return count;
}

export async function queryRegistrationStatus(
  request: Request,
  entrySegments: string[],
  sequencingQueueNs: SequencingQueueNamespace,
  r2Mmrs: R2Bucket,
  massifHeight: number,
  shardCountStr: string,
): Promise<Response> {
  const [logID, _, contentHashRaw] = entrySegments;

  if (!logID || !isUuid(logID)) {
    return ClientErrors.badRequest("logId must be a UUID");
  }
  if (!contentHashRaw || !isSha256Hex(contentHashRaw)) {
    return ClientErrors.badRequest("contentHash must be 64 hex characters");
  }

  const contentHash = contentHashRaw.toLowerCase();

  console.log("[query-registration-status] begin", {
    logID,
    contentHash,
    url: request.url,
  });

  try {
    // Get the SequencingQueue DO stub for this log's shard
    const shardCount = getShardCount(shardCountStr);
    const shardName = shardNameForLog(logID, shardCount);
    const doId = sequencingQueueNs.idFromName(shardName);
    const stub = sequencingQueueNs.get(doId);

    // Convert content hash hex to ArrayBuffer for DO query
    const contentHashBytes = hexToBuffer(contentHash);

    // Query the DO for the sequencing result
    const result = await stub.resolveContent(contentHashBytes);

    if (!result) {
      console.log("[query-registration-status] cache miss", {
        logID,
        contentHash,
      });

      // Still processing - return 303 with current location and short retry.
      const requestUrl = new URL(request.url);
      const currentLocation = `${requestUrl.origin}${requestUrl.pathname}`;
      return seeOtherResponse(currentLocation, 1);
    }

    // Sequencing complete - read idtimestamp from massif using byte-range
    const idtimestamp = await readIdtimestampFromMassif(
      r2Mmrs,
      logID,
      massifHeight,
      result.massifIndex,
      result.leafIndex,
    );

    // Convert leaf index to MMR index for the entry ID
    const mmrIndex = mmrIndexFromLeafIndex(result.leafIndex);

    console.log("[query-registration-status] cache hit", {
      logID,
      contentHash,
      leafIndex: result.leafIndex,
      massifIndex: result.massifIndex,
      idtimestamp: idtimestamp.toString(16),
      mmrIndex: mmrIndex.toString(),
    });

    const entryId = encodeEntryId({
      idtimestamp,
      mmrIndex,
    });

    const requestUrl = new URL(request.url);
    const permanentLocation = `${requestUrl.origin}/logs/${logID}/${massifHeight}/entries/${entryId}/receipt`;
    console.log("[query-registration-status] redirecting to receipt", {
      logID,
      contentHash,
      massifHeight,
      entryId,
      permanentLocation,
    });
    return seeOtherResponse(permanentLocation);
  } catch (error) {
    console.error("[query-registration-status] unhandled error", error);
    return ServerErrors.internal(
      error instanceof Error
        ? error.message
        : "Failed to query registration status",
    );
  }
}
