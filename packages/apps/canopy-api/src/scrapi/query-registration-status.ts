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
import { getQueueForLog } from "../sequeue/logshard.js";
import { seeOtherResponse } from "../cbor-api/cbor-response.js";
import { ClientErrors, ServerErrors } from "../cbor-api/problem-details.js";
import { encodeEntryId } from "./entry-id";
import {
  mmrIndexFromLeafIndex,
  readIdtimestampFromMassif,
} from "./sequencing-result.js";
import { logIdSegmentToCanonicalUuid } from "../grant/log-id-wire.js";
import { bytesToUuid } from "../grant/uuid-bytes.js";
import { getParsedGenesis } from "../forest/genesis-cache.js";

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

export async function queryRegistrationStatus(
  request: Request,
  entrySegments: string[],
  sequencingQueueNs: SequencingQueueNamespace,
  r2Mmrs: R2Bucket,
  massifHeight: number,
  shardCountStr: string,
  r2Grants: R2Bucket,
): Promise<Response> {
  const [bootstrapSeg, logIDRaw, _, contentHashRaw] = entrySegments;

  const genesisLookup = await getParsedGenesis(bootstrapSeg!, {
    R2_GRANTS: r2Grants,
  });
  if ("kind" in genesisLookup && genesisLookup.kind === "bad_segment") {
    return ClientErrors.badRequest("Invalid bootstrap log-id in path");
  }
  if ("kind" in genesisLookup && genesisLookup.kind === "not_found") {
    return ClientErrors.notFound(
      "Not Found",
      "Forest genesis not found for bootstrap log-id in path",
    );
  }
  if ("kind" in genesisLookup && genesisLookup.kind === "corrupt") {
    return ServerErrors.internal("Stored genesis for this forest is invalid");
  }
  const bootstrapUrlUuid = bytesToUuid(genesisLookup.wire);

  let logID: string;
  try {
    logID = logIdSegmentToCanonicalUuid(logIDRaw!);
  } catch {
    return ClientErrors.badRequest("logId in path must be a valid log id");
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
    const stub = getQueueForLog(
      { sequencingQueue: sequencingQueueNs, shardCountStr },
      logID,
    );

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
    const permanentLocation = `${requestUrl.origin}/logs/${bootstrapUrlUuid}/${logID}/${massifHeight}/entries/${entryId}/receipt`;
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
