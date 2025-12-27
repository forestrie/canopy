/**
 * Query Registration Status operation (SCRAPI 2.1.3) for Forestrie.
 *
 * Forestrie uses the statement content hash as the transient SCRAPI identifier.
 * This endpoint resolves that transient id to a permanent identifier once
 * sequencing is complete, by consulting the SequencedContent Durable Object.
 */

import type { SequencedContentStub } from "@canopy/ranger-sequence-types";
import { seeOtherResponse } from "./cbor-response";
import { ClientErrors, ServerErrors } from "./problem-details";
import { encodeEntryId } from "./entry-id";

function isUuid(id: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    id,
  );
}

function isSha256Hex(id: string): boolean {
  return /^[0-9a-f]{64}$/i.test(id);
}

/**
 * Convert a hex string to a bigint.
 */
function hexToBigint(hex: string): bigint {
  return BigInt(`0x${hex}`);
}

/**
 * Derive the Durable Object ID for a given log.
 *
 * Format: "{logId}/rangersequence"
 */
function deriveDoId(logId: string): string {
  return `${logId}/rangersequence`;
}

/**
 * Durable Object namespace interface for type safety.
 */
interface SequencedContentNamespace {
  idFromName(name: string): DurableObjectId;
  get(id: DurableObjectId): SequencedContentStub;
}

export async function queryRegistrationStatus(
  request: Request,
  entrySegments: string[],
  sequencedContentNs: SequencedContentNamespace,
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
    // Get the Durable Object stub for this log
    const doId = sequencedContentNs.idFromName(deriveDoId(logID));
    const stub = sequencedContentNs.get(doId);

    // Convert content hash hex to bigint for DO query
    const contentHashBigint = hexToBigint(contentHash);

    // Query the DO for the sequenced entry
    const entry = await stub.resolveContent(contentHashBigint);

    if (!entry) {
      console.log("[query-registration-status] cache miss", {
        logID,
        contentHash,
      });

      // Still processing - return 303 with current location and retry-after.
      const requestUrl = new URL(request.url);
      const currentLocation = `${requestUrl.origin}${requestUrl.pathname}`;
      return seeOtherResponse(currentLocation, 5);
    }

    console.log("[query-registration-status] cache hit", {
      logID,
      contentHash,
      idtimestamp: entry.idtimestamp.toString(16),
      mmrIndex: entry.mmrIndex.toString(),
    });

    const entryId = encodeEntryId({
      idtimestamp: entry.idtimestamp,
      mmrIndex: entry.mmrIndex,
    });

    const requestUrl = new URL(request.url);
    const permanentLocation = `${requestUrl.origin}/logs/${logID}/${entry.massifHeight}/entries/${entryId}/receipt`;
    console.log("[query-registration-status] redirecting to receipt", {
      logID,
      contentHash,
      massifHeight: entry.massifHeight,
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
