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
  CUSTODIAN_BOOTSTRAP_KEY_ID,
  fetchCustodianPublicKey,
  verifyCustodianEs256GrantSign1,
} from "./custodian-grant.js";
import { isLogInitializedMmrs } from "./log-initialized-mmrs.js";
import type { LogShardEnv } from "../sequeue/logshard.js";
import type { InclusionEnv } from "./verify-grant-inclusion.js";

const MAX_GRANT_BODY_SIZE = 4 * 1024; // 4 KiB

export interface RegisterGrantEnv {
  /**
   * When set: enqueue grants for sequencing (Subplan 03). With queue alone or initialized log,
   * {@link grantAuthorize} always runs (receipt + MMR inclusion) except the one-time bootstrap
   * success path (Subplan 08). Same DO namespace as register-signed-statement.
   */
  queueEnv?: LogShardEnv;
  /**
   * Subplan 08 / Plan 0014: Custodian bootstrap verification + MMRS "log exists" check
   * (first massif tile in R2_MMRS).
   */
  bootstrapEnv?: {
    rootLogId: string;
    custodianUrl: string;
    custodianBootstrapAppToken: string;
    bootstrapAlg?: "ES256" | "KS256";
    r2Mmrs: R2Bucket;
    massifHeight: number;
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
 * - env.bootstrapEnv: when set with queueEnv, enables bootstrap vs receipt-based branching (MMRS + Custodian).
 *
 * Bootstrapping (when both queueEnv and bootstrapEnv are set):
 * 1. Check whether the log has sequenced MMRS data (first massif tile in R2_MMRS). Small races
 *    vs the first write are acceptable; overlapping bootstrap-shaped grants are treated as idempotent.
 * 2. If the log is not initialized and the supplied grant is the bootstrap grant (ownerLogId
 *    equals logId, grant has GF_CREATE|GF_EXTEND, and the transparent statement’s signature
 *    verifies with the bootstrap public key from Custodian (RFC 8152 COSE Sign1)), accept it without
 *    inclusion check and enqueue. This is the first grant for the root log.
 * 3. If the log is not initialized but the grant is not bootstrap-shaped, return 403
 *    (problem detail distinguishes wrong shape vs failed COSE verify when shape matched).
 * 4. If the log is initialized (or bootstrapEnv is unset), require receipt-based inclusion
 *    ({@link grantAuthorize}): idtimestamp, receipt in the transparent statement, and MMR proof
 *    must verify for `ownerLogId`’s authority log; then enqueue.
 *
 * **Queue without bootstrapEnv:** Same as (4): always {@link grantAuthorize} before enqueue.
 * There is no separate “queue-only, no inclusion” mode.
 *
 * When queueEnv is unset, returns 503 (grant sequencing not configured).
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

  if (!env.queueEnv) {
    return ServerErrors.serviceUnavailable(
      "Grant sequencing not configured (SEQUENCING_QUEUE required)",
    );
  }

  // --- Subplan 08: optional bootstrap branch (requires bootstrapEnv + R2_MMRS first massif check) ---
  if (env.bootstrapEnv) {
    let logInitialized: boolean;
    try {
      logInitialized = await isLogInitializedMmrs(
        logId,
        env.bootstrapEnv.r2Mmrs,
        env.bootstrapEnv.massifHeight,
      );
    } catch (e) {
      console.warn("isLogInitializedMmrs failed", e);
      return ServerErrors.serviceUnavailable(
        e instanceof Error
          ? e.message
          : "Failed to read merklelog storage for log initialization check",
      );
    }

    // Bootstrap (§3.3): uninitialized root log, first grant — not in MMR yet, so no receipt.
    if (
      !logInitialized &&
      ownerLogIdEqualsLogId(grant, logId) &&
      hasCreateAndExtend(grant.grant as Uint8Array) &&
      grantResult.bytes
    ) {
      try {
        if (env.bootstrapEnv.bootstrapAlg === "KS256") {
          return ServerErrors.serviceUnavailable(
            "KS256 bootstrap grant verification is not implemented",
          );
        }
        const pk = await fetchCustodianPublicKey(
          env.bootstrapEnv.custodianUrl,
          CUSTODIAN_BOOTSTRAP_KEY_ID,
        );
        if (pk.alg !== "ES256") {
          return ServerErrors.serviceUnavailable(
            `Bootstrap grant verification requires Custodian key alg ES256; got ${pk.alg}`,
          );
        }
        let custodianHost = "";
        try {
          custodianHost = new URL(env.bootstrapEnv.custodianUrl).host;
        } catch {
          custodianHost = "(invalid-custodian-url)";
        }
        const spkiFingerprint = await sha256HexPrefix8(
          new TextEncoder().encode(pk.publicKeyPem),
        );
        console.warn(
          JSON.stringify({
            tag: "bootstrapGrantVerifyAttempt",
            custodianHost,
            keyId: pk.keyId,
            publicKeyAlg: pk.alg,
            spkiPemSha256HexPrefix: spkiFingerprint,
            transparentStatementLen: grantResult.bytes.length,
          }),
        );
        const ok = await verifyCustodianEs256GrantSign1(
          grantResult.bytes,
          pk.publicKeyPem,
          {
            logFailures: true,
            logPrefix: "register-grant-bootstrap",
          },
        );
        if (!ok) {
          return ClientErrors.forbidden(
            "Bootstrap grant COSE signature did not verify against Custodian :bootstrap public key (ES256).",
          );
        }
        return await enqueueAndStoreGrant(request, grant, env, logId);
      } catch (e) {
        console.warn(
          "Bootstrap branch (verify ok, enqueue or key fetch failed)",
          e,
        );
        return ServerErrors.serviceUnavailable(
          e instanceof Error
            ? e.message
            : "Grant sequencing failed after bootstrap verification",
        );
      }
    }

    if (!logInitialized) {
      return ClientErrors.forbidden(
        "Log has no MMRS data yet; use the bootstrap grant only (ownerLogId=logId, create+extend, Custodian-signed Forestrie-Grant).",
      );
    }
  }

  // --- Receipt-based inclusion for every other case (initialized log, or no bootstrapEnv) ---
  const authError = await grantAuthorize(grantResult, {
    inclusionEnv: env.queueEnv as InclusionEnv,
  });
  if (authError) return authError;
  return await enqueueAndStoreGrant(request, grant, env, logId);
}

/**
 * Enqueue grant to sequencing DO (Subplan 03, Plan 0008). No grant storage; return 303 to status URL.
 * Used by bootstrap and non-bootstrap paths when queue env is set.
 */
async function enqueueAndStoreGrant(
  request: Request,
  grant: Grant,
  env: RegisterGrantEnv,
  logId: string,
): Promise<Response> {
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

async function sha256HexPrefix8(data: BufferSource): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", data as BufferSource);
  const u8 = new Uint8Array(d);
  let s = "";
  for (let i = 0; i < Math.min(8, u8.length); i++) {
    s += u8[i]!.toString(16).padStart(2, "0");
  }
  return s;
}

/** Plan 0005: grant from Authorization: Forestrie-Grant only. */
function resolveAuth(
  request: Request,
): { grantResult: GrantResult } | Response {
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
