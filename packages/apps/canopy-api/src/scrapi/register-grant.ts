/**
 * Grant registration (`POST /register/{bootstrap-logid}/grants`). Admits a *new* grant into
 * the transparency system by enqueuing it for sequencing; canopy keeps no server-side grant
 * storage. See
 * [grants.md §10 Authorization and evidence model](https://github.com/forestrie/canopy/blob/main/docs/grants.md#10-authorization-and-evidence-model).
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
 * ## Two paths: creation vs steady-state
 *
 * - **Creation grant** (target `T` has no MMRS state yet): the grant is the credential being
 *   sealed for the first time, so it has no inclusion receipt. Validation is **delegated to the
 *   univocity owned grant store** ({@link CreationGrantValidator}): univocity verifies the COSE
 *   envelope against the owner `O`'s authority key, chains `O` to the on-chain bootstrap anchor,
 *   and atomically enforces global `logId → R` uniqueness. There is **no local fallback** — if no
 *   validator is configured, a creation grant returns `503`. The per-shape local crypto that this
 *   replaced now lives only in univocity (arbor `grant_test.go`).
 * - **Steady-state grant** (target `T` already has MMRS state): the grant must carry a valid
 *   inclusion receipt, checked by {@link grantAuthorize} — the same self-authenticating bar
 *   **register-signed-statement** uses for statement append.
 * - **Derived endorsement** (`GF_DERIVED|GF_EXTEND`, no `GF_CREATE`): target `R'` may have no
 *   MMRS; the leaf appends on warm owner `O` (`ownerLogId`). Verify envelope against `K(O)`
 *   (bootstrap anchor for v1 endorser root) and enqueue on `O`'s shard.
 */

import { grantCommitmentHashFromGrant } from "../grant/grant-commitment.js";
import {
  hasCreateAndExtend,
  isDerivedEndorsementGrant,
} from "../grant/grant-flags.js";
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
import { isLogInitializedMmrs } from "./log-initialized-mmrs.js";
import type { LogShardEnv } from "../sequeue/logshard.js";
import type { ReceiptAuthorityResolver } from "../env/receipt-authority-resolver.js";
import {
  getParsedGenesis,
  type ParsedForestGenesis,
} from "../forest/genesis-cache.js";
import type { CreationGrantValidator } from "./univocity-grant-client.js";
import { verifyDerivedEndorsementEnvelope } from "./verify-derived-endorsement-envelope.js";

export interface RegisterGrantEnv {
  /**
   * When set: enqueue grants for sequencing. With a queue and an initialized log,
   * {@link grantAuthorize} always runs (receipt + MMR inclusion). Same Durable
   * Object namespace as register-signed-statement.
   */
  queueEnv?: LogShardEnv;
  /**
   * Forest + log-state context: the bootstrap log id from the URL (the forest
   * root `R`), the genesis lookup bucket (R2_GRANTS), and the MMRS "log exists"
   * check (first massif tile in R2_MMRS).
   */
  bootstrapEnv: {
    bootstrapLogId: string;
    r2Grants: R2Bucket;
    r2Mmrs: R2Bucket;
    massifHeight: number;
  };
  /** Receipt authority resolver (trust root + delegation); required for receipt inclusion. */
  resolveReceiptAuthority?: ReceiptAuthorityResolver;
  /**
   * Creation-grant validation seam. Required to register a creation grant: when
   * absent, a creation grant returns `503`. The production implementation
   * forwards to the univocity owned grant store, which verifies the signature
   * chain against the owner's root key (anchored to the on-chain bootstrap key)
   * and enforces global `logId -> R` uniqueness. There is no local fallback.
   */
  creationGrantValidator?: CreationGrantValidator;
  /** Worker NODE_ENV; reserved for non-prod diagnostics. */
  nodeEnv?: string;
}

/**
 * Resolves `Authorization: Forestrie-Grant`, then chooses **creation** (delegated to univocity)
 * vs **steady-state** (receipt inclusion) authorization depending on MMRS initialization of the
 * target log. On success, enqueues the grant commitment on the **`ownerLogId`** queue shard.
 *
 * @see RegisterGrantEnv for the creation vs steady-state paths.
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
  const grantFlags = grant.grant as Uint8Array;

  let ownerLogUuid: string;
  try {
    ownerLogUuid = bytesToUuid(grant.ownerLogId);
  } catch {
    return ClientErrors.badRequest("Invalid ownerLogId in grant");
  }

  // MMRS on T decides the path: an initialized log requires an inclusion receipt
  // (grantAuthorize); an uninitialized log is opened by a creation grant, which
  // univocity validates and stores.
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

  // Creation grant (uninitialized T): delegated to the univocity owned grant
  // store. Univocity verifies the signature chain against the owner's root key
  // (anchored to the on-chain bootstrap key) and enforces global logId -> R
  // uniqueness atomically (201 new / 200 idempotent / 409 conflict). There is no
  // local fallback: without a validator a creation grant is a 503.
  if (!logInitialized) {
    if (isDerivedEndorsementGrant(grantFlags)) {
      return registerDerivedEndorsementGrant(
        request,
        grant,
        grantResult,
        env,
        targetLogUuid,
        ownerLogUuid,
        bootstrapUrlUuid,
        genesis,
      );
    }
    if (!hasCreateAndExtend(grantFlags) || !grantResult.bytes) {
      return ClientErrors.forbidden(
        "Log has no MMRS data yet; open it with a create+extend creation grant.",
      );
    }
    if (!env.creationGrantValidator) {
      return ServerErrors.serviceUnavailable(
        "Creation-grant validation is not configured (univocity required).",
      );
    }
    const decision = await env.creationGrantValidator.validate(
      genesis.wire,
      grantResult.bytes,
    );
    switch (decision.kind) {
      case "accepted":
        try {
          return await enqueueAndStoreGrant(
            request,
            grant,
            env,
            targetLogUuid,
            bootstrapUrlUuid,
          );
        } catch (e) {
          console.warn("Creation grant (univocity ok, enqueue failed)", e);
          return ServerErrors.serviceUnavailable(
            e instanceof Error
              ? e.message
              : "Grant sequencing failed after univocity validation",
          );
        }
      case "conflict":
        return ClientErrors.conflict(
          "logId already registered to a different forest (global uniqueness).",
        );
      case "rejected":
        return ClientErrors.forbidden(
          decision.detail ||
            "Univocity rejected the creation grant (invalid signature chain).",
        );
      case "unavailable":
        return ServerErrors.serviceUnavailable(
          decision.detail || "Univocity grant validation is unavailable.",
        );
    }
  }

  // Log (T) has MMRS: grant must carry a valid receipt (same bar as register-signed-statement).
  // Reached only when queueEnv is configured (503 earlier otherwise), so enforce inclusion.
  const authError = await grantAuthorize(grantResult, {
    enforceInclusion: Boolean(env.queueEnv),
    resolveReceiptAuthority: env.resolveReceiptAuthority,
    ks256ChainId: genesis.chainBinding?.chainId,
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
      targetLogUuid,
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

async function registerDerivedEndorsementGrant(
  request: Request,
  grant: Grant,
  grantResult: GrantResult,
  env: RegisterGrantEnv,
  endorsedRootUuid: string,
  ownerLogUuid: string,
  bootstrapUrlUuid: string,
  genesis: ParsedForestGenesis,
): Promise<Response> {
  if (ownerLogUuid !== bootstrapUrlUuid) {
    return ClientErrors.forbidden(
      "Derived endorsement grant must be registered on the endorser forest root.",
    );
  }
  if (endorsedRootUuid === ownerLogUuid) {
    return ClientErrors.forbidden(
      "Endorsement grant logId must name the endorsed forest root R', not the endorser.",
    );
  }

  let ownerInitialized: boolean;
  try {
    ownerInitialized = await isLogInitializedMmrs(
      ownerLogUuid,
      env.bootstrapEnv.r2Mmrs,
      env.bootstrapEnv.massifHeight,
    );
  } catch (e) {
    console.warn("isLogInitializedMmrs (owner) failed", e);
    return ServerErrors.serviceUnavailable(
      e instanceof Error
        ? e.message
        : "Failed to read merklelog storage for endorser log initialization check",
    );
  }
  if (!ownerInitialized) {
    return ClientErrors.forbidden(
      "Endorser log has no MMRS data yet; bootstrap the endorser forest first.",
    );
  }

  const verified = await verifyDerivedEndorsementEnvelope(grantResult, genesis);
  if (!verified) {
    return ClientErrors.forbidden(
      "Derived endorsement grant envelope signature did not verify against the endorser authority key.",
    );
  }

  try {
    return await enqueueAndStoreGrant(
      request,
      grant,
      env,
      endorsedRootUuid,
      bootstrapUrlUuid,
    );
  } catch (e) {
    console.warn("Derived endorsement grant enqueue failed", e);
    return ServerErrors.serviceUnavailable(
      e instanceof Error
        ? e.message
        : "Grant sequencing failed after endorsement verify",
    );
  }
}

function resolveAuth(
  request: Request,
): { grantResult: GrantResult } | Response {
  const result = getGrantFromRequest(request);
  if (result instanceof Response) return result;
  return { grantResult: result };
}
