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
import {
  urkleLeafTableStartByteOffset,
  leafCountForMassifHeight,
} from "@canopy/merklelog";
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

/** Leaf record size in bytes (from Urkle.LeafRecordBytes) */
const LEAF_RECORD_BYTES = 128;

/** ID timestamp size in bytes (first 8 bytes of leaf record) */
const IDTIMESTAMP_BYTES = 8;

/**
 * Compute MMR index from leaf index.
 *
 * Translated from go-merklelog/mmr/mmrindex.go MMRIndex
 */
function mmrIndexFromLeafIndex(leafIndex: number): bigint {
  let sum = 0n;
  let current = BigInt(leafIndex);

  while (current > 0n) {
    const h = BigInt(current.toString(2).length);
    sum += (1n << h) - 1n;
    const half = 1n << (h - 1n);
    current -= half;
  }

  return sum;
}

/**
 * Read the idtimestamp for a leaf entry using an efficient byte-range request.
 *
 * This reads only the 8-byte idtimestamp field from the massif, avoiding
 * downloading the entire massif blob (which can be several MB).
 *
 * @param r2 - R2 bucket binding
 * @param logId - Log UUID
 * @param massifHeight - Massif height (1-based)
 * @param massifIndex - Massif index
 * @param leafIndex - Global leaf index
 * @returns The idtimestamp as bigint
 */
async function readIdtimestampFromMassif(
  r2: R2Bucket,
  logId: string,
  massifHeight: number,
  massifIndex: number,
  leafIndex: number,
): Promise<bigint> {
  // Compute the leaf ordinal within the massif
  const leavesPerMassif = Number(leafCountForMassifHeight(massifHeight));
  const leafOrdinal = leafIndex % leavesPerMassif;

  // Compute byte offset of the idtimestamp within the massif
  const leafTableStart = urkleLeafTableStartByteOffset(massifHeight);
  const leafRecordOffset = leafTableStart + leafOrdinal * LEAF_RECORD_BYTES;
  // idtimestamp is at offset 0 within the leaf record

  // Format massif index as 16-digit zero-padded decimal
  const objectIndex = massifIndex.toString().padStart(16, "0");
  const objectKey = `v2/merklelog/massifs/${massifHeight}/${logId}/${objectIndex}.log`;

  // Use byte-range request to read only the 8-byte idtimestamp
  const object = await r2.get(objectKey, {
    range: { offset: leafRecordOffset, length: IDTIMESTAMP_BYTES },
  });

  if (!object) {
    throw new Error(`Massif not found: ${objectKey}`);
  }

  const data = await object.arrayBuffer();
  if (data.byteLength < IDTIMESTAMP_BYTES) {
    throw new Error(
      `Massif range read returned insufficient bytes: ${data.byteLength}`,
    );
  }

  // Read big-endian uint64
  const view = new DataView(data);
  return view.getBigUint64(0, false);
}

export async function queryRegistrationStatus(
  request: Request,
  entrySegments: string[],
  sequencingQueueNs: SequencingQueueNamespace,
  r2Mmrs: R2Bucket,
  massifHeight: number,
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
    // Get the global SequencingQueue DO stub
    const doId = sequencingQueueNs.idFromName("global");
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
