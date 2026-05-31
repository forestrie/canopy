/**
 * Grant registration (`POST /register/{bootstrap-logid}/grants`). Admits a *new* grant into
 * the transparency system by enqueuing it for sequencing; there is no server-side grant
 * storage. The full authorization and evidence model for this endpoint lives in
 * [grants.md §10 Authorization and evidence model](https://github.com/forestrie/canopy/blob/main/docs/grants.md#10-authorization-and-evidence-model);
 * the per-shape creation paths are tabulated in
 * [grants.md §6 Register-grant creation paths](https://github.com/forestrie/canopy/blob/main/docs/grants.md#6-register-grant-creation-paths).
 *
 * ## Logs (T vs O) and hierarchy
 *
 * - **Target log `T`** — `grant.logId`: the log the grant applies to (the child log when issuing
 *   a child grant, or the root when bootstrapping).
 * - **Owner / authority log `O`** — `grant.ownerLogId`: the parent authority log that sequences
 *   grants for this operation. The sequencing queue shard is keyed by **`O`** (last 16 bytes),
 *   not `T`. For a root bootstrap grant, `O === T`; for a child-first grant, `O` is the parent
 *   auth log and `T` is the new child log. See
 *   [grants.md §2 logId vs ownerLogId](https://github.com/forestrie/canopy/blob/main/docs/grants.md#2-logid-vs-ownerlogid-authorized-vs-owning).
 *
 * ## Credential vs evidence
 *
 * The grant in `Authorization: Forestrie-Grant` is the **credential**: it is signed by the
 * authority of its owner log `O` and, by that signature, both authorizes the operation and
 * is the new resource being created. A **creation** grant has no receipt yet (it is being
 * submitted to be sealed for the first time), so {@link grantAuthorize} cannot authenticate
 * it by inclusion. Instead its COSE signature is verified against the authority key of its
 * owner `O`, and `O`'s legitimacy is chained to the trust anchor (forest genesis). For an
 * **intermediate** owner that is not the anchor, the caller supplies `O`'s completed creation
 * grant as **public verification evidence** in the request body (see the child-data branch
 * and [grants.md §11 Evidence transport](https://github.com/forestrie/canopy/blob/main/docs/grants.md#11-evidence-transport-parent-grant-post-body)).
 *
 * ## Pairing with {@link registerSignedStatement}
 *
 * Once a log has MMRS state, **every** accepted grant goes through {@link grantAuthorize}
 * (receipt inclusion) — the same single, self-authenticating check **register-signed-statement**
 * always uses. In other words: hierarchical logs are *opened* here with first-grant verification;
 * steady-state grants and statement append both prove authority via completed, included grants.
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
import {
  getGrantFromRequest,
  getParentGrantFromRequest,
  grantAuthorize,
} from "./auth-grant.js";
import { QueueFullError } from "@canopy/forestrie-ingress-types";
import { seeOtherResponse } from "../cbor-api/cbor-response.js";
import {
  enqueueGrantForSequencing,
  type GrantSequencingEnv,
} from "./grant-sequencing.js";
import { ClientErrors, ServerErrors } from "../cbor-api/problem-details.js";
import { verifyGrantCoseSign1WithGrantDataXy } from "./custodian-grant.js";
import { isLogInitializedMmrs } from "./log-initialized-mmrs.js";
import type { LogShardEnv } from "../sequeue/logshard.js";
import type { ReceiptAuthorityResolver } from "../env/receipt-authority-resolver.js";
import { bytesEqual } from "../cbor-api/cbor-map-utils.js";
import { getParsedGenesis } from "../forest/genesis-cache.js";
import { hydrateGrantReceiptFromMmrs } from "./hydrate-grant-receipt.js";

export interface RegisterGrantEnv {
  /**
   * When set: enqueue grants for sequencing. With a queue and an initialized log,
   * {@link grantAuthorize} always runs (receipt + MMR inclusion) except the one-time
   * first-grant paths. Same Durable Object namespace as register-signed-statement.
   */
  queueEnv?: LogShardEnv;
  /**
   * Bootstrap / first-grant verification context: forest genesis (in R2_GRANTS) and the
   * MMRS "log exists" check (first massif tile in R2_MMRS). Present on validated workers;
   * absent only in pool tests with incomplete bindings.
   */
  /** Bootstrap log id from URL + storage; genesis must exist in R2_GRANTS. */
  bootstrapEnv: {
    bootstrapLogId: string;
    r2Grants: R2Bucket;
    custodianUrl: string;
    /** Curator custody paths (`curator/log-key`); optional in pool tests. */
    custodianAppToken: string;
    bootstrapAlg?: "ES256" | "KS256";
    r2Mmrs: R2Bucket;
    massifHeight: number;
  };
  /** Receipt authority resolver (trust root + delegation); required for receipt inclusion. */
  resolveReceiptAuthority?: ReceiptAuthorityResolver;
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

  // Root authority log: first grant on T where O===T — COSE verifies against grantData x‖y
  // that must match curated forest genesis (trust anchor is genesis + embedded pubkey, not a fixed Custodian alias).
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
      const gdRoot = grantDataToBytes(grant.grantData);
      if (gdRoot.length !== 64) {
        return ClientErrors.forbidden(
          "Bootstrap grant requires 64-byte grantData (x||y).",
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
      let custodianHost = "";
      try {
        custodianHost = new URL(env.bootstrapEnv.custodianUrl).host;
      } catch {
        custodianHost = "(invalid-custodian-url)";
      }
      console.warn(
        JSON.stringify({
          tag: "bootstrapGrantVerifyAttempt",
          custodianHost,
          grantDataXySha256HexPrefix: await sha256HexPrefix8(gdRoot),
          transparentStatementLen: grantResult.bytes.length,
        }),
      );
      const ok = await verifyGrantCoseSign1WithGrantDataXy(
        grantResult.bytes,
        gdRoot,
        {
          logFailures: true,
          logPrefix: "register-grant-bootstrap",
        },
      );
      if (!ok) {
        return ClientErrors.forbidden(
          "Bootstrap grant COSE signature did not verify against grantData public key.",
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
        "Child auth first grant requires 64-byte grantData (x||y).",
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
    const ok = await verifyGrantCoseSign1WithGrantDataXy(
      grantResult.bytes,
      gd,
      {
        logFailures: true,
        logPrefix: "register-grant-child-auth-first",
      },
    );
    if (!ok) {
      return ClientErrors.forbidden(
        "Child auth first grant: COSE signature did not verify against grantData public key.",
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

  // Child *data* log first grant: O!==T, data-log flags only. The data grant is the
  // credential (signed by O's authority); O's legitimacy must be established without
  // reading ephemeral SequencingQueue state. The two-grants-only-here rationale and the
  // trust chain (genesis anchor -> R seals A -> A signs D) are documented in
  // grants.md §10:
  //   https://github.com/forestrie/canopy/blob/main/docs/grants.md#10-authorization-and-evidence-model
  //
  //  - Parent is the root genesis log R (parentUuid === bootstrapUrlUuid): R legitimately
  //    owns its own first massif via the self-referential bootstrap grant, so readiness is
  //    `isLogInitializedMmrs(R)` and the data grant must be signed by R's authority key
  //    (the forest genesis x||y) — R is the trust anchor, so no parent evidence is needed.
  //    Cheap (one R2 head), queue-free.
  //  - Parent is an intermediate auth log A (parentUuid !== bootstrapUrlUuid): A has no own
  //    massif (its creation-grant leaf is sealed on R), so `isLogInitializedMmrs(A)` is
  //    meaningless. A is not the anchor, so the caller must supply A's completed creation
  //    grant as public verification evidence in the request body ({ parentGrant: <bytes> },
  //    grants.md §11:
  //    https://github.com/forestrie/canopy/blob/main/docs/grants.md#11-evidence-transport-parent-grant-post-body).
  //    We verify that grant's receipt against R's receipt authority (grantAuthorize),
  //    confirm it created A (logId === parentUuid), then require the data grant to be signed
  //    by the authority key A's creation grant established (its grantData x||y).
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
        "Child data first grant requires 64-byte grantData (x||y).",
      );
    }
    let parentUuid: string;
    try {
      parentUuid = bytesToUuid(grant.ownerLogId);
    } catch {
      return ClientErrors.badRequest("Invalid ownerLogId in grant");
    }

    // The public key that must have signed this data grant (the parent authority key).
    let authorityKeyXy: Uint8Array;

    if (parentUuid === bootstrapUrlUuid) {
      // Root-owned data log: the root R owns its own first massif. Readiness is the R2
      // head of R's first massif; the authority key is the forest genesis x||y.
      let rootInitialized: boolean;
      try {
        rootInitialized = await isLogInitializedMmrs(
          parentUuid,
          env.bootstrapEnv.r2Mmrs,
          env.bootstrapEnv.massifHeight,
        );
      } catch (e) {
        console.warn(
          "isLogInitializedMmrs (root parent, child data) failed",
          e,
        );
        return ServerErrors.serviceUnavailable(
          e instanceof Error
            ? e.message
            : "Failed to read merklelog storage for parent initialization check",
        );
      }
      if (!rootInitialized) {
        return ClientErrors.forbidden(
          "Root log has no MMRS data yet; bootstrap the root before root-owned data grants.",
        );
      }
      authorityKeyXy = new Uint8Array(64);
      authorityKeyXy.set(genesis.x.subarray(0, 32), 0);
      authorityKeyXy.set(genesis.y.subarray(0, 32), 32);
    } else {
      // Intermediate auth log A: prove A's creation grant is sealed on R from the receipt
      // the caller supplies in the request body — no queue read, no isLogInitializedMmrs(A),
      // no Custodian fetch. The parent grant is public, replayable evidence (not a
      // credential); possession conveys no authority, so the server re-verifies it here.
      const parentGrantResult = await getParentGrantFromRequest(request);
      if (parentGrantResult instanceof Response) return parentGrantResult;
      if (!parentGrantResult) {
        return ClientErrors.forbidden(
          "Child data grant under an intermediate authority log requires the parent's completed creation grant in the request body ({ parentGrant: <bytes> }) so its seal can be verified.",
        );
      }
      let parentGrantLogUuid: string;
      try {
        parentGrantLogUuid = bytesToUuid(parentGrantResult.grant.logId);
      } catch {
        return ClientErrors.badRequest("Invalid logId in parent grant");
      }
      if (parentGrantLogUuid !== parentUuid) {
        return ClientErrors.forbidden(
          "Parent grant in the request body does not create this grant's owner authority log (logId mismatch).",
        );
      }
      // Rebuild parent receipt from MMRS so delegation cert + inclusion proof match
      // resolve-receipt (caller-supplied bytes may omit checkpoint cert label 1000).
      const parentForAuthorize = await hydrateGrantReceiptFromMmrs(
        parentGrantResult,
        env.bootstrapEnv.r2Mmrs,
        env.bootstrapEnv.massifHeight,
      );
      // grantAuthorize verifies the parent grant's receipt (MMR inclusion + signature)
      // against the receipt authority for the parent grant's own ownerLogId (R).
      const parentAuthError = await grantAuthorize(parentForAuthorize, {
        enforceInclusion: Boolean(env.queueEnv),
        resolveReceiptAuthority: env.resolveReceiptAuthority,
      });
      if (parentAuthError) return parentAuthError;

      authorityKeyXy = grantDataToBytes(parentGrantResult.grant.grantData);
      if (authorityKeyXy.length !== 64) {
        return ClientErrors.forbidden(
          "Parent creation grant grantData must be 64-byte ES256 x||y (authority key).",
        );
      }
    }

    const ok = await verifyGrantCoseSign1WithGrantDataXy(
      grantResult.bytes,
      authorityKeyXy,
      {
        logFailures: true,
        logPrefix: "register-grant-child-data-first",
      },
    );
    if (!ok) {
      return ClientErrors.forbidden(
        "Child data first grant: COSE signature did not verify against the parent authority key.",
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
  // Reached only when queueEnv is configured (503 earlier otherwise), so enforce inclusion.
  const authError = await grantAuthorize(grantResult, {
    enforceInclusion: Boolean(env.queueEnv),
    resolveReceiptAuthority: env.resolveReceiptAuthority,
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
