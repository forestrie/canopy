/**
 * Query Registration Status operation (SCRAPI 2.1.3) for Forestrie.
 *
 * Forestrie uses the statement content hash as the transient SCRAPI identifier.
 * This endpoint resolves that transient id to a permanent identifier once
 * sequencing is complete, by consulting the receipt-resolution KV cache.
 *
 * KV key: ranger/v1/{logId}/latest/{contentHashHex}
 * KV value (v1 JSON): { v: 1, massifHeight: number, mmrIndex: string, idtimestamp: string }
 */

import { seeOtherResponse } from "./cbor-response";
import { ClientErrors, ServerErrors } from "./problem-details";
import { encodeEntryId } from "./entry-id";

interface ReceiptCacheValueV1 {
  v: number;
  massifHeight: number;
  mmrIndex: string;
  idtimestamp: string;
}

function isUuid(id: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    id,
  );
}

function isSha256Hex(id: string): boolean {
  return /^[0-9a-f]{64}$/i.test(id);
}

export async function queryRegistrationStatus(
  request: Request,
  entrySegments: string[],
  kv: KVNamespace,
): Promise<Response> {
  const [logID, _, contentHashRaw] = entrySegments;

  if (!logID || !isUuid(logID)) {
    return ClientErrors.badRequest("logId must be a UUID");
  }
  if (!contentHashRaw || !isSha256Hex(contentHashRaw)) {
    return ClientErrors.badRequest("contentHash must be 64 hex characters");
  }

  const contentHash = contentHashRaw.toLowerCase();
  const key = `ranger/v1/${logID}/latest/${contentHash}`;

  // Lightweight debug logging to help trace cache lookups end-to-end.
  console.log("[query-registration-status] begin", {
    logID,
    contentHash,
    key,
    url: request.url,
  });

  try {
    const raw = await kv.get(key);
    if (!raw) {
      console.log("[query-registration-status] cache miss", { key });

      // Still processing - return 303 with current location and retry-after.
      const requestUrl = new URL(request.url);
      const currentLocation = `${requestUrl.origin}${requestUrl.pathname}`;
      return seeOtherResponse(currentLocation, 5);
    }

    const rawTrimmed = raw.trim();
    console.log("[query-registration-status] cache hit", {
      key,
      rawPreview: rawTrimmed.slice(0, 128),
    });

    // During rollout, older values may be stored as a bare decimal string idtimestamp.
    // We cannot build the permanent identifier without (massifHeight, mmrIndex).
    if (!rawTrimmed.startsWith("{")) {
      console.error(
        "[query-registration-status] schema mismatch (non-JSON value)",
        { key, rawPreview: rawTrimmed.slice(0, 128) },
      );
      return ServerErrors.serviceUnavailable(
        `Receipt cache schema mismatch for ${key}; expected v1 JSON value`,
      );
    }

    let parsed: ReceiptCacheValueV1;
    try {
      parsed = JSON.parse(rawTrimmed) as ReceiptCacheValueV1;
    } catch (error) {
      console.error("[query-registration-status] JSON parse failed", {
        key,
        rawPreview: rawTrimmed.slice(0, 128),
        error: error instanceof Error ? error.message : String(error),
      });
      return ServerErrors.internal(
        `Failed to parse receipt cache JSON for ${key}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    if (
      !parsed ||
      parsed.v !== 1 ||
      typeof parsed.massifHeight !== "number" ||
      typeof parsed.mmrIndex !== "string" ||
      typeof parsed.idtimestamp !== "string"
    ) {
      console.error("[query-registration-status] invalid cache value shape", {
        key,
        parsed,
      });
      return ServerErrors.internal(`Invalid receipt cache value for ${key}`);
    }

    const massifHeight = parsed.massifHeight;
    if (
      !Number.isInteger(massifHeight) ||
      massifHeight < 1 ||
      massifHeight > 64
    ) {
      console.error(
        "[query-registration-status] invalid massifHeight in cache value",
        { key, massifHeight },
      );
      return ServerErrors.internal(
        `Invalid massifHeight in receipt cache value for ${key}`,
      );
    }

    if (!/^[0-9]+$/.test(parsed.mmrIndex)) {
      console.error(
        "[query-registration-status] invalid mmrIndex in cache value",
        { key, mmrIndex: parsed.mmrIndex },
      );
      return ServerErrors.internal(
        `Invalid mmrIndex in receipt cache value for ${key}`,
      );
    }
    if (!/^[0-9a-f]+$/i.test(parsed.idtimestamp)) {
      console.error(
        "[query-registration-status] invalid idtimestamp in cache value",
        { key, idtimestamp: parsed.idtimestamp },
      );
      return ServerErrors.internal(
        `Invalid idtimestamp in receipt cache value for ${key}`,
      );
    }

    let idtimestampBigInt: bigint;
    try {
      // Forester writes idtimestamp as lowercase hex digits without a 0x prefix.
      idtimestampBigInt = BigInt(`0x${parsed.idtimestamp}`);
    } catch (error) {
      console.error(
        "[query-registration-status] failed to parse idtimestamp as hex",
        { key, idtimestamp: parsed.idtimestamp, error },
      );
      return ServerErrors.internal(
        `Failed to parse idtimestamp in receipt cache value for ${key}`,
      );
    }

    const entryId = encodeEntryId({
      idtimestamp: idtimestampBigInt,
      mmrIndex: parsed.mmrIndex,
    });

    const requestUrl = new URL(request.url);
    const permanentLocation = `${requestUrl.origin}/logs/${logID}/${massifHeight}/entries/${entryId}/receipt`;
    console.log("[query-registration-status] redirecting to receipt", {
      key,
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
