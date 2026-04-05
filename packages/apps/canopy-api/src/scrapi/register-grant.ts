/**
 * Grant registration (`POST /register/{bootstrap-logid}/grants`). Enqueues a caller-supplied grant for sequencing;
 * no server-side grant storage.
 *
 * ## Logs (T vs O) and hierarchy
 *
 * - **Target log `T`** — `grant.logId`: the log the grant applies to (the child log when issuing
 *   a child grant, or the root when bootstrapping).
 * - **Owner / authority log `O`** — `grant.ownerLogId`: the parent authority log that sequences
 *   grants for this operation. The sequencing queue shard is keyed by **`O`** (last 16 bytes),
 *   not `T`. For a root bootstrap grant, `O === T`; for a child-first grant, `O` is the parent
 *   auth log and `T` is the new child log.
 *
 * ## Pairing with {@link registerSignedStatement}
 *
 * **register-grant** admits *new* grants into the transparency system. When the relevant log (or,
 * for child-first grants, the **parent** log) still has **no MMRS tile**, a SCITT receipt cannot
 * exist yet, so {@link grantAuthorize} cannot be used. This module implements **bootstrap /
 * first-grant** verification instead (Custodian COSE for root; statement-signer binding in
 * `grantData` for child auth/data logs once the parent is MMRS-initialized). After the log has
 * MMRS state, **every** accepted grant goes through {@link grantAuthorize} (receipt inclusion) —
 * the same primitive **register-signed-statement** always uses for grant auth. In other words:
 * hierarchical logs are opened with register-grant; ongoing minted grants and statement append
 * both prove authority via completed, included grants.
 *
 * ## Auth-critical branches (when `bootstrapEnv` is set)
 *
 * Uninitialized **target** `T`: root bootstrap (`O === T`), child **auth** first grant, or child
 * **data** first grant — each with explicit COSE checks. If `T` is uninitialized and none of those
 * shapes match → 403. Initialized `T` → {@link grantAuthorize} then enqueue.
 */

import { grantDataToBytes } from "../grant/grant-data.js";
import {
  hasAuthLogClass,
  hasCreateAndExtend,
  hasDataLogClass,
} from "../grant/grant-flags.js";
import { grantCommitmentHashFromGrant } from "../grant/grant-commitment.js";
import type { Grant, GrantResult } from "../grant/types.js";
import { bytesToUuid } from "../grant/uuid-bytes.js";
import { getGrantFromRequest, grantAuthorize } from "./auth-grant.js";
import { QueueFullError } from "@canopy/forestrie-ingress-types";
import { seeOtherResponse } from "../cbor-api/cbor-response.js";
import {
  enqueueGrantForSequencing,
  type GrantSequencingEnv,
} from "./grant-sequencing.js";
import { ClientErrors, ServerErrors } from "../cbor-api/problem-details.js";
import {
  CUSTODIAN_BOOTSTRAP_KEY_ID,
  fetchCustodianPublicKey,
  verifyCustodianEs256GrantSign1,
  verifyCustodianEs256GrantSign1WithGrantDataXy,
} from "./custodian-grant.js";
import { isLogInitializedMmrs } from "./log-initialized-mmrs.js";
import type { LogShardEnv } from "../sequeue/logshard.js";
import type { InclusionEnv } from "./verify-grant-inclusion.js";
import type { ReceiptVerifyKeyResolver } from "../env/receipt-verify-key-resolver.js";
import { bytesEqual } from "../cbor-api/cbor-map-utils.js";
import { getParsedGenesis } from "../forest/genesis-cache.js";

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
   * (first massif tile in R2_MMRS). From index on validated workers; absent only in pool tests
   * with incomplete bindings.
   */
  /** Bootstrap log id from URL + storage; genesis must exist in R2_GRANTS. */
  bootstrapEnv: {
    bootstrapLogId: string;
    r2Grants: R2Bucket;
    custodianUrl: string;
    custodianBootstrapAppToken: string;
    bootstrapAlg?: "ES256" | "KS256";
    r2Mmrs: R2Bucket;
    massifHeight: number;
  };
  /** Custodian (or pool-test) receipt Sign1 verify key; required when using receipt inclusion. */
  resolveReceiptVerifyKey?: ReceiptVerifyKeyResolver;
}

/**
 * Resolves `Authorization: Forestrie-Grant`, then chooses **bootstrap / first-grant** vs
 * **receipt** authorization depending on MMRS initialization and grant shape (see file comment).
 * On success, enqueues the grant commitment on the **`ownerLogId`** queue shard.
 *
 * @see RegisterGrantEnv for bootstrap vs receipt paths.
 */
export async function registerGrant(
  request: Request,
  env: RegisterGrantEnv,
): Promise<Response> {
  const authResult = resolveAuth(request);
  if (authResult instanceof Response) return authResult;
  const { grantResult } = authResult;
  const grant = grantResult.grant;

  let targetLogUuid: string;
  try {
    targetLogUuid = bytesToUuid(grant.logId);
  } catch {
    return ClientErrors.badRequest("Invalid logId in grant");
  }

  if (!env.queueEnv) {
    return ServerErrors.serviceUnavailable(
      "Grant sequencing not configured (SEQUENCING_QUEUE required)",
    );
  }

  const genesisLookup = await getParsedGenesis(
    env.bootstrapEnv.bootstrapLogId,
    {
      R2_GRANTS: env.bootstrapEnv.r2Grants,
    },
  );
  if ("kind" in genesisLookup && genesisLookup.kind === "bad_segment") {
    return ClientErrors.badRequest("Invalid bootstrap log-id in path");
  }
  if ("kind" in genesisLookup && genesisLookup.kind === "not_found") {
    return ClientErrors.notFound(
      "Not Found",
      "Forest genesis not found; provision POST /api/forest/{log-id}/genesis first.",
    );
  }
  if ("kind" in genesisLookup && genesisLookup.kind === "corrupt") {
    return ServerErrors.internal("Stored genesis for this forest is invalid");
  }
  const genesis = genesisLookup;
  const bootstrapUrlUuid = bytesToUuid(genesis.wire);

  // MMRS on T decides whether we can require an inclusion receipt (grantAuthorize) or must
  // use one of the pre-receipt bootstrap / child-first paths below. Child-first paths also
  // require the parent O to be initialized so the chain of authority is anchored.
  let logInitialized: boolean;
  try {
    logInitialized = await isLogInitializedMmrs(
      targetLogUuid,
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

  // Root authority log: first grant on T where O===T — Custodian :bootstrap key verifies COSE.
  if (
    !logInitialized &&
    ownerMatchesTargetUuid(grant, targetLogUuid) &&
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
      const gdRoot = grantDataToBytes(grant.grantData);
      if (gdRoot.length !== 64) {
        return ClientErrors.forbidden(
          "Bootstrap grant requires 64-byte ES256 grantData (x||y).",
        );
      }
      for (let i = 0; i < 32; i++) {
        if (gdRoot[i] !== genesis.x[i] || gdRoot[i + 32] !== genesis.y[i]) {
          return ClientErrors.forbidden(
            "Bootstrap grant public key does not match forest genesis.",
          );
        }
      }
      if (!bytesEqual(grant.logId, genesis.wire)) {
        return ClientErrors.forbidden(
          "Bootstrap grant logId must match forest bootstrap log.",
        );
      }
      return await enqueueAndStoreGrant(
        request,
        grant,
        env,
        targetLogUuid,
        bootstrapUrlUuid,
      );
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

  // Child *auth* log first grant: O!==T, auth-log class — parent O must be MMRS-hot; COSE vs grantData (x||y).
  if (
    !logInitialized &&
    !ownerMatchesTargetUuid(grant, targetLogUuid) &&
    hasCreateAndExtend(grant.grant as Uint8Array) &&
    hasAuthLogClass(grant.grant as Uint8Array) &&
    grantResult.bytes
  ) {
    const gd = grantDataToBytes(grant.grantData);
    if (gd.length !== 64) {
      return ClientErrors.forbidden(
        "Child auth first grant requires 64-byte ES256 grantData (x||y).",
      );
    }
    let parentUuid: string;
    try {
      parentUuid = bytesToUuid(grant.ownerLogId);
    } catch {
      return ClientErrors.badRequest("Invalid ownerLogId in grant");
    }
    let parentInitialized: boolean;
    try {
      parentInitialized = await isLogInitializedMmrs(
        parentUuid,
        env.bootstrapEnv.r2Mmrs,
        env.bootstrapEnv.massifHeight,
      );
    } catch (e) {
      console.warn("isLogInitializedMmrs (parent) failed", e);
      return ServerErrors.serviceUnavailable(
        e instanceof Error
          ? e.message
          : "Failed to read merklelog storage for parent initialization check",
      );
    }
    if (!parentInitialized) {
      return ClientErrors.forbidden(
        "Parent authority log has no MMRS data yet; bootstrap the root before child auth grants.",
      );
    }
    const ok = await verifyCustodianEs256GrantSign1WithGrantDataXy(
      grantResult.bytes,
      gd,
      {
        logFailures: true,
        logPrefix: "register-grant-child-auth-first",
      },
    );
    if (!ok) {
      return ClientErrors.forbidden(
        "Child auth first grant: COSE signature did not verify against grantData public key (ES256).",
      );
    }
    try {
      return await enqueueAndStoreGrant(
        request,
        grant,
        env,
        targetLogUuid,
        bootstrapUrlUuid,
      );
    } catch (e) {
      console.warn("Child auth first grant (verify ok, enqueue failed)", e);
      return ServerErrors.serviceUnavailable(
        e instanceof Error
          ? e.message
          : "Grant sequencing failed after child auth grant verification",
      );
    }
  }

  // Child *data* log first grant: O!==T, data-log flags only — same parent/MMRS and grantData verify pattern as auth child.
  if (
    !logInitialized &&
    !ownerMatchesTargetUuid(grant, targetLogUuid) &&
    hasCreateAndExtend(grant.grant as Uint8Array) &&
    hasDataLogClass(grant.grant as Uint8Array) &&
    !hasAuthLogClass(grant.grant as Uint8Array) &&
    grantResult.bytes
  ) {
    const gd = grantDataToBytes(grant.grantData);
    if (gd.length !== 64) {
      return ClientErrors.forbidden(
        "Child data first grant requires 64-byte ES256 grantData (x||y).",
      );
    }
    let parentUuid: string;
    try {
      parentUuid = bytesToUuid(grant.ownerLogId);
    } catch {
      return ClientErrors.badRequest("Invalid ownerLogId in grant");
    }
    let parentInitialized: boolean;
    try {
      parentInitialized = await isLogInitializedMmrs(
        parentUuid,
        env.bootstrapEnv.r2Mmrs,
        env.bootstrapEnv.massifHeight,
      );
    } catch (e) {
      console.warn("isLogInitializedMmrs (parent, child data) failed", e);
      return ServerErrors.serviceUnavailable(
        e instanceof Error
          ? e.message
          : "Failed to read merklelog storage for parent initialization check",
      );
    }
    if (!parentInitialized) {
      return ClientErrors.forbidden(
        "Authority log has no MMRS data yet; initialize the owner log before child data grants.",
      );
    }
    const ok = await verifyCustodianEs256GrantSign1WithGrantDataXy(
      grantResult.bytes,
      gd,
      {
        logFailures: true,
        logPrefix: "register-grant-child-data-first",
      },
    );
    if (!ok) {
      return ClientErrors.forbidden(
        "Child data first grant: COSE signature did not verify against grantData public key (ES256).",
      );
    }
    try {
      return await enqueueAndStoreGrant(
        request,
        grant,
        env,
        targetLogUuid,
        bootstrapUrlUuid,
      );
    } catch (e) {
      console.warn("Child data first grant (verify ok, enqueue failed)", e);
      return ServerErrors.serviceUnavailable(
        e instanceof Error
          ? e.message
          : "Grant sequencing failed after child data grant verification",
      );
    }
  }

  if (!logInitialized) {
    return ClientErrors.forbidden(
      "Log has no MMRS data yet; use the bootstrap grant only (ownerLogId=logId, create+extend, Custodian-signed Forestrie-Grant).",
    );
  }

  // Log (T) has MMRS: grant must carry a valid receipt (same bar as register-signed-statement).
  const authError = await grantAuthorize(grantResult, {
    inclusionEnv: env.queueEnv as InclusionEnv,
    resolveReceiptVerifyKey: env.resolveReceiptVerifyKey,
  });
  if (authError) return authError;
  return await enqueueAndStoreGrant(
    request,
    grant,
    env,
    targetLogUuid,
    bootstrapUrlUuid,
  );
}

async function enqueueAndStoreGrant(
  request: Request,
  grant: Grant,
  env: RegisterGrantEnv,
  targetLogUuid: string,
  bootstrapCanonicalLogId: string,
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
      bootstrapCanonicalLogId,
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
    targetLogUuid,
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

function resolveAuth(
  request: Request,
): { grantResult: GrantResult } | Response {
  const result = getGrantFromRequest(request);
  if (result instanceof Response) return result;
  return { grantResult: result };
}

/** True when authority log equals target log (root bootstrap shape). */
function ownerMatchesTargetUuid(grant: Grant, targetUuid: string): boolean {
  try {
    return bytesToUuid(grant.ownerLogId) === targetUuid;
  } catch {
    return false;
  }
}
