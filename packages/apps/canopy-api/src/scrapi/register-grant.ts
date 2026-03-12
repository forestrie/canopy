/**
 * Register-grant endpoint (Plan 0001 Step 6, Plan 0004 subplan 03).
 * POST /logs/{logId}/grants — create grant, enqueue for sequencing, return 303 to status URL.
 * Body must be grant wire format (go-univocity: CBOR map keys 0–8).
 * When sequencingEnv is provided, grant is stored by inner hash and 303 is returned (client polls query-registration-status).
 */

import { decodeGrant, encodeGrant } from "../grant/codec.js";
import { innerHashFromGrant, innerHashToHex } from "../grant/inner-hash.js";
import { kindBytesToSegment } from "../grant/kinds.js";
import { grantStoragePath } from "../grant/storage-path.js";
import type { Grant } from "../grant/types.js";
import { bytesToUuid } from "../grant/uuid-bytes.js";
import { QueueFullError } from "@canopy/forestrie-ingress-types";
import { getContentSize } from "./cbor-request";
import { cborResponse, seeOtherResponse } from "./cbor-response";
import {
  enqueueGrantForSequencing,
  type GrantSequencingEnv,
} from "./grant-sequencing.js";
import { ClientErrors, ServerErrors } from "./problem-details";

const MAX_GRANT_BODY_SIZE = 4 * 1024; // 4 KiB

/** Storage path for sequenced grants: authority/{innerHex}.cbor so GET can complete by inner. */
const SEQUENCED_GRANT_KIND_SEGMENT = "authority";

export interface RegisterGrantEnv {
  r2Grants: R2Bucket;
  sequencingEnv?: GrantSequencingEnv;
}

/**
 * Handle POST /logs/{logId}/grants.
 * Request body must be full grant CBOR (wire format keys 0–8).
 * When sequencingEnv is set: store at authority/{innerHex}.cbor, enqueue, return 303 to status URL.
 */
export async function registerGrant(
  request: Request,
  logId: string,
  env: RegisterGrantEnv,
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

  const useSequencing = env.sequencingEnv != null;

  if (useSequencing) {
    const inner = await innerHashFromGrant(grant);
    const ownerLogId =
      grant.ownerLogId.length >= 16
        ? grant.ownerLogId.slice(-16)
        : grant.ownerLogId;
    let result;
    try {
      result = await enqueueGrantForSequencing(
        ownerLogId,
        inner,
        env.sequencingEnv!,
      );
    } catch (error) {
      if (error instanceof QueueFullError) {
        return ServerErrors.serviceUnavailableWithRetry(
          `Queue capacity exceeded (${error.pendingCount}/${error.maxPending} pending)`,
          error.retryAfterSeconds,
        );
      }
      throw error;
    }

    const grantWithPlaceholder: Grant = {
      ...grant,
      idtimestamp: new Uint8Array(8),
    };
    const encoded = encodeGrant(grantWithPlaceholder);
    const storagePath = `${SEQUENCED_GRANT_KIND_SEGMENT}/${result.innerHex}.cbor`;

    try {
      await env.r2Grants.put(storagePath, encoded);
    } catch (e) {
      console.error("Grant storage put failed", e);
      return ServerErrors.storageError(
        e instanceof Error ? e.message : "R2 put failed",
      );
    }

    const requestUrl = new URL(request.url);
    const statusUrl = `${requestUrl.origin}${result.statusUrlPath}`;
    const grantLocationPath = `/grants/${SEQUENCED_GRANT_KIND_SEGMENT}/${result.innerHex}`;

    console.log("Grant enqueued for sequencing", {
      statusUrlPath: result.statusUrlPath,
      grantLocation: grantLocationPath,
      alreadySequenced: result.alreadySequenced,
      logId,
    });

    const res = seeOtherResponse(statusUrl, 5);
    res.headers.set("X-Grant-Location", grantLocationPath);
    return res;
  }

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
    await env.r2Grants.put(storagePath, encoded);
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

  return cborResponse(
    { location: locationPath, kind: kindBytesToSegment(grantWithId.kind) },
    201,
    {
      Location: locationPath,
      "Content-Type": "application/cbor",
    },
  );
}
