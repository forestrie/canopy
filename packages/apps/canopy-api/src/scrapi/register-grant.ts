/**
 * Grant registration (POST /logs/{logId}/grants). Enqueues a caller-supplied grant for
 * sequencing; no server-side grant storage.
 */

import { hasCreateAndExtend } from "../grant/grant-flags.js";
import { grantCommitmentHashFromGrant } from "../grant/grant-commitment.js";
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

export interface RegisterGrantEnv {
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
    bootstrapAlg?: "ES256" | "KS256";
    univocityServiceUrl: string;
  };
}

/**
 * Handles POST /logs/{logId}/grants. Enqueues the caller-supplied grant for sequencing so it
 * becomes a leaf in the authority log identified by grant.ownerLogId. The grant is always
 * supplied in the request via Authorization: Forestrie-Grant <base64> (a SCITT transparent
 * statement; payload is grant content, idtimestamp and receipt in headers). No server-side
 * grant storage: the caller obtains idtimestamp and receipt after sequencing via
 * query-registration-status (303 to …/entries/{entryId}/receipt) and resolve-receipt.
 *
 * Parameters:
 * - request: must include Authorization: Forestrie-Grant with a valid transparent statement.
 * - logId: log ID from the URL; grant.logId must match (target log of the grant).
 * - env.queueEnv: when set, enqueue is performed (same DO namespace as register-signed-statement).
 * - env.bootstrapEnv: when set together with queueEnv, enables bootstrap vs receipt-based branching.
 *
 * Bootstrapping (when both queueEnv and bootstrapEnv are set):
 * 1. Ask univocity whether the log is initialized (isLogInitialized(logId)).
 * 2. If the log is not initialized and the supplied grant is the bootstrap grant (ownerLogId
 *    equals logId, grant has GF_CREATE|GF_EXTEND, and the transparent statement’s signature
 *    verifies with the bootstrap public key from the delegation signer), accept it without
 *    inclusion check and enqueue. This is the first grant for the root log.
 * 3. If the log is not initialized but the grant is not the bootstrap grant, return 403
 *    (log not initialized; use bootstrap grant to bootstrap).
 * 4. If the log is initialized, require receipt-based inclusion (grantAuthorize): the grant’s
 *    receipt (in the transparent statement header) must verify against the authority log;
 *    then enqueue.
 *
 * When only queueEnv is set (no bootstrapEnv), every valid grant is enqueued without
 * inclusion check. When queueEnv is unset, returns 503 (grant sequencing not configured).
 *
 * Agent References: Plan 0001 Step 6; Plan 0004 Subplan 03 (grant-sequencing), Subplan 08
 * (grant-first bootstrap, receipt-based inclusion); Plan 0005 (Forestrie-Grant only);
 * Plan 0008 (no grant storage, no X-Grant-Location).
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
          bootstrapAlg: env.bootstrapEnv.bootstrapAlg,
        });
        const ok = await verifyBootstrapCoseSign1(
          grantResult.bytes,
          bootstrapKey.publicKeyBytes,
          bootstrapKey.alg,
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
  // Enqueue to grant-sequencing DO (Subplan 03); return 303 to status URL. No grant storage
  // (Plan 0008); caller gets idtimestamp and receipt via query-registration-status and resolve-receipt.
  if (useQueue) {
    const inner = await grantCommitmentHashFromGrant(grant);
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

    const requestUrl = new URL(request.url);
    const statusUrl = `${requestUrl.origin}${result.statusUrlPath}`;

    console.log("Grant enqueued for sequencing", {
      statusUrlPath: result.statusUrlPath,
      alreadySequenced: result.alreadySequenced,
      logId,
    });

    return seeOtherResponse(statusUrl, 5);
  }

  // No queue configured: grant sequencing is required for this endpoint.
  return ServerErrors.serviceUnavailable(
    "Grant sequencing not configured (SEQUENCING_QUEUE required)",
  );
}

/**
 * Enqueue grant to sequencing DO (Subplan 03, Plan 0008). No grant storage; return 303 to status URL.
 * Used by bootstrap and non-bootstrap paths when queue env is set.
 */
async function enqueueAndStoreGrant(
  request: Request,
  grant: Grant,
  env: RegisterGrantEnv,
): Promise<Response> {
  const inner = await grantCommitmentHashFromGrant(grant);
  const ownerLogId =
    grant.ownerLogId.length >= 16
      ? grant.ownerLogId.slice(-16)
      : grant.ownerLogId;
  const result = await enqueueGrantForSequencing(
    ownerLogId,
    inner,
    env.queueEnv! as GrantSequencingEnv,
  );
  const requestUrl = new URL(request.url);
  const statusUrl = `${requestUrl.origin}${result.statusUrlPath}`;
  return seeOtherResponse(statusUrl, 5);
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
