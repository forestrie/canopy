/**
 * Register-grant endpoint (Plan 0001 Step 6, Plan 0004 subplan 03, 08).
 * POST /logs/{logId}/grants — create grant, enqueue for sequencing, return 303 to status URL.
 * Auth: body (grant CBOR) or X-Grant-Location (path to grant). Subplan 08: bootstrap branch when
 * logId not initialized and auth is bootstrap-signed; non-bootstrap requires inclusion (contracts).
 */

import { encodeGrantPayload } from "../grant/codec.js";
import { hasCreateAndExtend } from "../grant/grant-flags.js";
import { innerHashFromGrant } from "../grant/inner-hash.js";
import type { Grant, GrantResult } from "../grant/types.js";
import { bytesToUuid } from "../grant/uuid-bytes.js";
import { getGrantFromRequest, grantAuthorize } from "./auth-grant.js";
import { QueueFullError } from "@canopy/forestrie-ingress-types";
import { seeOtherResponse } from "./cbor-response";
import {
  enqueueGrantForSequencing,
  type GrantSequencingEnv,
} from "./grant-sequencing.js";
import { ClientErrors, ServerErrors } from "./problem-details";
import {
  getBootstrapPublicKey,
  verifyBootstrapCoseSign1,
} from "./bootstrap-public-key.js";
import { isLogInitialized } from "./univocity-rest.js";
import type { LogShardEnv } from "../sequeue/logshard.js";
import type { InclusionEnv } from "./verify-grant-inclusion.js";

const MAX_GRANT_BODY_SIZE = 4 * 1024; // 4 KiB

/** Storage path for sequenced grants: authority/{innerHex}.cbor so GET can complete by inner. */
const SEQUENCED_GRANT_KIND_SEGMENT = "authority";

export interface RegisterGrantEnv {
  r2Grants: R2Bucket;
  /**
   * When set: enqueue grants for sequencing (Subplan 03) and, when bootstrapEnv is also set,
   * require receipt-based inclusion for non-bootstrap auth (Subplan 08). Same queue for both.
   */
  queueEnv?: LogShardEnv;
  /** Subplan 08: root log id (hex), delegation-signer URL and token, univocity REST URL. */
  bootstrapEnv?: {
    rootLogId: string;
    delegationSignerUrl: string;
    delegationSignerBearerToken: string;
    delegationSignerPublicKeyToken?: string;
    univocityServiceUrl: string;
  };
}

/**
 * Handle POST /logs/{logId}/grants.
 *
 * Architecture: Plan 0001 Step 6 (create grant, enqueue); Plan 0004 Subplan 03 (grant-sequencing,
 * same DO as register-signed-statement); Subplan 08 (grant-first bootstrap, receipt-based
 * inclusion for non-bootstrap). Flow: resolve auth → validate grant vs URL → branch by env
 * (bootstrap vs inclusion vs sequencing-only) → enqueue and store or legacy store.
 */
export async function registerGrant(
  request: Request,
  logId: string,
  env: RegisterGrantEnv,
): Promise<Response> {
  // --- Resolve auth grant (Authorization: Forestrie-Grant only, Plan 0005) ---
  const authResult = resolveAuth(request);
  if (authResult instanceof Response) return authResult;
  const { grantResult } = authResult;
  const grant = grantResult.grant;

  // --- Grant must target this log (URL logId matches grant.logId) ---
  if (!logIdBytesMatchUrl(grant, logId)) {
    return ClientErrors.badRequest("logId in grant must match URL logId");
  }

  const useQueue = env.queueEnv != null;

  // --- Path when bootstrap env and queue are configured (Subplan 08) ---
  // Determines log-initialized vs bootstrap branch; then either bootstrap enqueue or
  // receipt-based authorization (shared grantAuthorize) + enqueue.
  if (env.bootstrapEnv && env.queueEnv && useQueue) {
    const logInitialized = await isLogInitialized(logId, {
      univocityServiceUrl: env.bootstrapEnv.univocityServiceUrl,
    }).catch(() => true);

    // Bootstrap branch (Subplan 08 §3.3): log not yet initialized, auth is bootstrap grant
    // (ownerLogId = logId, GF_CREATE|GF_EXTEND, signature from bootstrap key). No inclusion
    // check; enqueue and store, then 303 to status URL.
    if (
      !logInitialized &&
      ownerLogIdEqualsLogId(grant, logId) &&
      hasCreateAndExtend(grant.grantFlags as Uint8Array) &&
      grantResult.bytes
    ) {
      try {
        const bootstrapKey = await getBootstrapPublicKey({
          delegationSignerUrl: env.bootstrapEnv.delegationSignerUrl,
          delegationSignerPublicKeyToken: env.bootstrapEnv.delegationSignerPublicKeyToken,
        });
        const ok = await verifyBootstrapCoseSign1(
          grantResult.bytes,
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

    // Non-bootstrap: receipt-based inclusion (Subplan 08 §3.3.1, ARC-0001). grantAuthorize uses
    // receipt from artifact only (Plan 0005).
    const authError = await grantAuthorize(grantResult, {
      inclusionEnv: env.queueEnv as InclusionEnv | undefined,
    });
    if (authError) return authError;
    return await enqueueAndStoreGrant(request, grant, env);
  }

  // --- Path when only queue is configured (no bootstrap env) ---
  // Enqueue to grant-sequencing DO (Subplan 03); store grant at authority/{innerHex}.cbor;
  // return 303 to status URL with X-Grant-Location. No inclusion/receipt check on auth grant.
  if (useQueue) {
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
        env.queueEnv! as GrantSequencingEnv,
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

    // Plan 0006: store grant content only (1–8); idtimestamp comes from massif when serving.
    const contentBytes = encodeGrantPayload(grant);
    const storagePath = `${SEQUENCED_GRANT_KIND_SEGMENT}/${result.innerHex}.cbor`;

    try {
      await env.r2Grants.put(storagePath, contentBytes);
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

  // No queue configured: grant sequencing is required for this endpoint.
  return ServerErrors.serviceUnavailable(
    "Grant sequencing not configured (SEQUENCING_QUEUE required)",
  );
}

/**
 * Enqueue grant to sequencing DO and store at authority/{innerHex}.cbor (Subplan 03).
 * Used by bootstrap and non-bootstrap paths when queue env is set.
 */
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
    env.queueEnv! as GrantSequencingEnv,
  );
  // Plan 0006: store grant content only (1–8); idtimestamp comes from massif when serving.
  const contentBytes = encodeGrantPayload(grant);
  const storagePath = `${SEQUENCED_GRANT_KIND_SEGMENT}/${result.innerHex}.cbor`;
  await env.r2Grants.put(storagePath, contentBytes);
  const requestUrl = new URL(request.url);
  const statusUrl = `${requestUrl.origin}${result.statusUrlPath}`;
  const grantLocationPath = `/grants/${SEQUENCED_GRANT_KIND_SEGMENT}/${result.innerHex}`;
  const res = seeOtherResponse(statusUrl, 5);
  res.headers.set("X-Grant-Location", grantLocationPath);
  return res;
}

/** Plan 0005: grant from Authorization: Forestrie-Grant only. */
function resolveAuth(request: Request): { grantResult: GrantResult } | Response {
  const result = getGrantFromRequest(request);
  if (result instanceof Response) return result;
  return { grantResult: result };
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
