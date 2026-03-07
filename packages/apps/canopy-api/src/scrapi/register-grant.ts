/**
 * Register-grant endpoint (Plan 0001 Step 6).
 * POST /logs/{logId}/grants — create grant, store in R2, return path-only location.
 */

import { encodeGrant } from "../grant/codec.js";
import {
  GRANT_FLAGS_BYTES,
  KIND_BYTES,
  kindBytesToSegment,
} from "../grant/kinds.js";
import { grantStoragePath } from "../grant/storage-path.js";
import {
  GRANT_VERSION,
  type Grant,
  type GrantRequest,
} from "../grant/types.js";
import { bytesToUuid, LOG_ID_BYTES } from "../grant/uuid-bytes.js";
import { toBytes, toBytesLength, toNumber } from "../unknown-coercion.js";
import { getContentSize, parseCborBody } from "./cbor-request";
import { cborResponse } from "./cbor-response";
import { ClientErrors, ServerErrors } from "./problem-details";

const MAX_GRANT_BODY_SIZE = 4 * 1024; // 4 KiB

/**
 * Parse and validate grant request body (CBOR map with string or int keys).
 * logId, ownerLogId are 16 bytes; grantFlags 8 bytes; kind 1 byte.
 */
function parseGrantRequest(
  raw: unknown,
  urlLogId: string,
): GrantRequest | string {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return "Grant request must be a CBOR map";
  }
  const m = raw as Record<string | number, unknown>;

  const logId = toBytesLength(m.logId ?? m[3], LOG_ID_BYTES);
  if (!logId) return "Missing or invalid logId (must be 16 bytes)";
  const ownerLogId = toBytesLength(m.ownerLogId ?? m[4], LOG_ID_BYTES);
  if (!ownerLogId) return "Missing or invalid ownerLogId (must be 16 bytes)";
  const grantFlags = toBytesLength(m.grantFlags ?? m[5], GRANT_FLAGS_BYTES);
  if (!grantFlags) return "Missing or invalid grantFlags (must be 8 bytes)";
  const grantData = toBytes(m.grantData ?? m[8]) ?? new Uint8Array(0);
  const signer = toBytes(m.signer ?? m[9]);
  if (!signer || signer.length === 0) return "Missing signer";
  const kind = toBytesLength(m.kind ?? m[10], KIND_BYTES);
  if (!kind) return "Missing or invalid kind (must be 1 byte)";

  try {
    if (bytesToUuid(logId) !== urlLogId)
      return "logId in body must match URL logId";
  } catch {
    return "Invalid logId bytes";
  }

  const req: GrantRequest = {
    version: GRANT_VERSION,
    logId,
    ownerLogId,
    grantFlags,
    grantData,
    signer,
    kind,
  };

  const maxHeight = toNumber(m.maxHeight ?? m[6]);
  if (maxHeight !== undefined) req.maxHeight = maxHeight;
  const minGrowth = toNumber(m.minGrowth ?? m[7]);
  if (minGrowth !== undefined) req.minGrowth = minGrowth;
  const exp = toNumber(m.exp ?? m[11]);
  if (exp !== undefined) req.exp = exp;
  const nbf = toNumber(m.nbf ?? m[12]);
  if (nbf !== undefined) req.nbf = nbf;

  return req;
}

/**
 * Handle POST /logs/{logId}/grants.
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

  let raw: unknown;
  try {
    raw = await parseCborBody(request);
  } catch (e) {
    return ClientErrors.badRequest(
      `Invalid CBOR: ${e instanceof Error ? e.message : "parse error"}`,
    );
  }

  const parsed = parseGrantRequest(raw, logId);
  if (typeof parsed === "string") {
    return ClientErrors.badRequest(parsed);
  }

  // Deterministic idtimestamp from request content so same request → same path (content-addressable idempotency)
  const canonicalGrant: Grant = {
    ...parsed,
    idtimestamp: new Uint8Array(8),
  };
  const canonicalBytes = encodeGrant(canonicalGrant);
  const hash = await crypto.subtle.digest("SHA-256", canonicalBytes);
  const idtimestamp = new Uint8Array(hash.slice(0, 8));

  const grant: Grant = {
    ...parsed,
    idtimestamp,
  };

  const encoded = encodeGrant(grant);
  const storagePath = await grantStoragePath(encoded, grant.kind);

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
    kind: kindBytesToSegment(grant.kind),
    logId,
  });

  const body = { location: locationPath, kind: kindBytesToSegment(grant.kind) };
  return cborResponse(body, 201, {
    Location: locationPath,
    "Content-Type": "application/cbor",
  });
}
