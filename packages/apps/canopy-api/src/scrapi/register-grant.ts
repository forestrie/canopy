/**
 * Register-grant endpoint (Plan 0001 Step 6).
 * POST /logs/{logId}/grants — create grant, store in R2, return path-only location.
 * Body must be grant wire format (go-univocity: CBOR map keys 0–8).
 */

import { decodeGrant, encodeGrant } from "../grant/codec.js";
import { kindBytesToSegment } from "../grant/kinds.js";
import { grantStoragePath } from "../grant/storage-path.js";
import type { Grant } from "../grant/types.js";
import { bytesToUuid } from "../grant/uuid-bytes.js";
import { getContentSize } from "./cbor-request";
import { cborResponse } from "./cbor-response";
import { ClientErrors, ServerErrors } from "./problem-details";

const MAX_GRANT_BODY_SIZE = 4 * 1024; // 4 KiB

/**
 * Handle POST /logs/{logId}/grants.
 * Request body must be full grant CBOR (wire format keys 0–8); idtimestamp is overwritten by server.
 */
export async function registerGrant(
  request: Request,
  logId: string,
  r2Grants: R2Bucket,
): Promise<Response> {
  const contentType = request.headers.get("content-type") || "";
  if (!contentType.includes("cbor")) {
    return ClientErrors.unsupportedMediaType("Use application/cbor");
  }

  const size = getContentSize(request);
  if (typeof size === "number" && size > MAX_GRANT_BODY_SIZE) {
    return ClientErrors.payloadTooLarge(size, MAX_GRANT_BODY_SIZE);
  }

  let bodyBytes: Uint8Array;
  try {
    const buffer = await request.arrayBuffer();
    bodyBytes = new Uint8Array(buffer);
  } catch (e) {
    return ClientErrors.badRequest(
      `Body read failed: ${e instanceof Error ? e.message : "unknown"}`,
    );
  }

  let grant: Grant;
  try {
    grant = decodeGrant(bodyBytes);
  } catch (e) {
    return ClientErrors.badRequest(
      `Invalid grant CBOR: ${e instanceof Error ? e.message : "decode failed"}`,
    );
  }

  try {
    if (bytesToUuid(grant.logId) !== logId) {
      return ClientErrors.badRequest("logId in body must match URL logId");
    }
  } catch {
    return ClientErrors.badRequest("Invalid logId bytes");
  }

  // Deterministic idtimestamp from request content (content-addressable idempotency)
  const canonicalGrant: Grant = {
    ...grant,
    idtimestamp: new Uint8Array(8),
  };
  const canonicalBytes = encodeGrant(canonicalGrant);
  const hash = await crypto.subtle.digest("SHA-256", canonicalBytes);
  const idtimestamp = new Uint8Array(hash.slice(0, 8));

  const grantWithId: Grant = {
    ...grant,
    idtimestamp,
  };

  const encoded = encodeGrant(grantWithId);
  const storagePath = await grantStoragePath(encoded, grantWithId.kind);

  try {
    await r2Grants.put(storagePath, encoded);
  } catch (e) {
    console.error("Grant storage put failed", e);
    return ServerErrors.storageError(
      e instanceof Error ? e.message : "R2 put failed",
    );
  }

  const locationPath = `/${storagePath}`;
  console.log("Grant created", {
    location: locationPath,
    kind: kindBytesToSegment(grantWithId.kind),
    logId,
  });

  const body = {
    location: locationPath,
    kind: kindBytesToSegment(grantWithId.kind),
  };
  return cborResponse(body, 201, {
    Location: locationPath,
    "Content-Type": "application/cbor",
  });
}
