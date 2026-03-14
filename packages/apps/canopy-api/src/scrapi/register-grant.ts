/**
 * Register-grant endpoint (Plan 0001 Step 6, Plan 0004 subplan 03, 08).
 * POST /logs/{logId}/grants — create grant, enqueue for sequencing, return 303 to status URL.
 * Auth: body (grant CBOR) or X-Grant-Location (path to grant). Subplan 08: bootstrap branch when
 * logId not initialized and auth is bootstrap-signed; non-bootstrap requires inclusion (contracts).
 */

import { decodeGrant, encodeGrant } from "../grant/codec.js";
import { hasCreateAndExtend } from "../grant/grant-flags.js";
import { innerHashFromGrant, innerHashToHex } from "../grant/inner-hash.js";
import { kindBytesToSegment } from "../grant/kinds.js";
import { grantStoragePath } from "../grant/storage-path.js";
import type { Grant } from "../grant/types.js";
import { bytesToUuid } from "../grant/uuid-bytes.js";
import { getGrantLocationFromRequest, fetchGrant } from "./grant-auth.js";
import { QueueFullError } from "@canopy/forestrie-ingress-types";
import { getContentSize } from "./cbor-request";
import { cborResponse, seeOtherResponse } from "./cbor-response";
import {
  enqueueGrantForSequencing,
  type GrantSequencingEnv,
} from "./grant-sequencing.js";
import { ClientErrors, ServerErrors } from "./problem-details";
import { fetchBootstrapGrantWithSignature } from "./bootstrap-grant.js";
import { getBootstrapPublicKey, verifyBootstrapSignature } from "./bootstrap-public-key.js";
import { isLogInitialized } from "./univocity-rest.js";
import type { InclusionEnv } from "./verify-grant-inclusion.js";
import { verifyGrantIncluded } from "./verify-grant-inclusion.js";

const MAX_GRANT_BODY_SIZE = 4 * 1024; // 4 KiB

/** Storage path for sequenced grants: authority/{innerHex}.cbor so GET can complete by inner. */
const SEQUENCED_GRANT_KIND_SEGMENT = "authority";

export interface RegisterGrantEnv {
  r2Grants: R2Bucket;
  sequencingEnv?: GrantSequencingEnv;
  /** Subplan 08: root log id (hex), delegation-signer URL and token, univocity REST URL. */
  bootstrapEnv?: {
    rootLogId: string;
    delegationSignerUrl: string;
    delegationSignerBearerToken: string;
    delegationSignerPublicKeyToken?: string;
    univocityServiceUrl: string;
  };
  /** Subplan 08: inclusion verification; chain and/or storage, at least one required when used (8.6). */
  inclusionEnv?: InclusionEnv;
}

/**
 * Resolve auth grant from request: body (CBOR) or X-Grant-Location (fetch from R2 or bootstrap doc).
 */
async function resolveAuth(
  request: Request,
  logId: string,
  env: RegisterGrantEnv,
): Promise<{ grant: Grant; signature?: string } | Response> {
  const grantLocation = getGrantLocationFromRequest(request);
  if (grantLocation) {
    if (env.bootstrapEnv) {
      const bootstrap = await fetchBootstrapGrantWithSignature(
        env.r2Grants,
        grantLocation,
        env.bootstrapEnv.rootLogId,
      );
      if (bootstrap) {
        return { grant: bootstrap.grant, signature: bootstrap.signature };
      }
    }
    const fetched = await fetchGrant(env.r2Grants, grantLocation);
    if (!fetched) return ClientErrors.badRequest("Grant not found at location");
    return { grant: fetched.grant };
  }
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
    bodyBytes = new Uint8Array(await request.arrayBuffer());
  } catch (e) {
    return ClientErrors.badRequest(
      `Body read failed: ${e instanceof Error ? e.message : "unknown"}`,
    );
  }
  try {
    const grant = decodeGrant(bodyBytes);
    return { grant };
  } catch (e) {
    return ClientErrors.badRequest(
      `Invalid grant CBOR: ${e instanceof Error ? e.message : "decode failed"}`,
    );
  }
}

function logIdBytesMatchUrl(grant: Grant, logId: string): boolean {
  try {
    return bytesToUuid(grant.logId) === logId;
  } catch {
    return false;
  }
}

function ownerLogIdEqualsLogId(grant: Grant, logId: string): boolean {
  try {
    return bytesToUuid(grant.ownerLogId) === logId;
  } catch {
    return false;
  }
}

function hexToBytes(hex: string): Uint8Array {
  const s = hex.replace(/^0x/i, "").trim();
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

async function enqueueAndStoreGrant(
  request: Request,
  grant: Grant,
  env: RegisterGrantEnv,
): Promise<Response> {
  const inner = await innerHashFromGrant(grant);
  const ownerLogId =
    grant.ownerLogId.length >= 16
      ? grant.ownerLogId.slice(-16)
      : grant.ownerLogId;
  const result = await enqueueGrantForSequencing(
    ownerLogId,
    inner,
    env.sequencingEnv!,
  );
  const grantWithPlaceholder: Grant = {
    ...grant,
    idtimestamp: new Uint8Array(8),
  };
  const encoded = encodeGrant(grantWithPlaceholder);
  const storagePath = `${SEQUENCED_GRANT_KIND_SEGMENT}/${result.innerHex}.cbor`;
  await env.r2Grants.put(storagePath, encoded);
  const requestUrl = new URL(request.url);
  const statusUrl = `${requestUrl.origin}${result.statusUrlPath}`;
  const grantLocationPath = `/grants/${SEQUENCED_GRANT_KIND_SEGMENT}/${result.innerHex}`;
  const res = seeOtherResponse(statusUrl, 5);
  res.headers.set("X-Grant-Location", grantLocationPath);
  return res;
}

/**
 * Handle POST /logs/{logId}/grants.
 * Auth: body (grant CBOR) or X-Grant-Location. Subplan 08: bootstrap branch or inclusion check when env provided.
 */
export async function registerGrant(
  request: Request,
  logId: string,
  env: RegisterGrantEnv,
): Promise<Response> {
  const authResult = await resolveAuth(request, logId, env);
  if (authResult instanceof Response) return authResult;
  const { grant, signature } = authResult;

  if (!logIdBytesMatchUrl(grant, logId)) {
    return ClientErrors.badRequest("logId in grant must match URL logId");
  }

  const useSequencing = env.sequencingEnv != null;

  if (env.bootstrapEnv && env.sequencingEnv && useSequencing) {
    const logInitialized = await isLogInitialized(logId, {
      univocityServiceUrl: env.bootstrapEnv.univocityServiceUrl,
    }).catch(() => true);
    if (
      !logInitialized &&
      ownerLogIdEqualsLogId(grant, logId) &&
      hasCreateAndExtend(grant.grantFlags as Uint8Array) &&
      signature
    ) {
      try {
        const bootstrapKey = await getBootstrapPublicKey({
          delegationSignerUrl: env.bootstrapEnv.delegationSignerUrl,
          delegationSignerPublicKeyToken: env.bootstrapEnv.delegationSignerPublicKeyToken,
        });
        const inner = await innerHashFromGrant(grant);
        const sigBytes = hexToBytes(signature);
        const ok = await verifyBootstrapSignature(
          inner,
          sigBytes,
          bootstrapKey.publicKeyBytes,
        );
        if (ok) {
          return await enqueueAndStoreGrant(request, grant, env);
        }
      } catch (e) {
        console.warn("Bootstrap branch verification failed", e);
      }
    }
    if (!logInitialized) {
      return ClientErrors.forbidden(
        "Log not initialized; use bootstrap grant as auth to bootstrap",
      );
    }
    if (env.inclusionEnv) {
      const included = await verifyGrantIncluded(grant, env.inclusionEnv);
      if (!included) {
        return ClientErrors.forbidden(
          "Grant must be included in owner log (inclusion verification failed)",
        );
      }
    }
    return await enqueueAndStoreGrant(request, grant, env);
  }

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
