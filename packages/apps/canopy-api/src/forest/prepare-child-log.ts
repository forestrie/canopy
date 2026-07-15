/**
 * `POST /api/forest/{childLogId}/prepare` — register a child log's public root with
 * the delegation coordinator **under parent-log authority, without sequencing the
 * create leaf** (ADR-0053 Part B / plan-2607-23). Lets an owner pre-sign an advance
 * delegation for a not-yet-existent child log.
 *
 * ## Transport
 *
 * The parent-signed create grant is carried as the request **credential** in
 * `Authorization: Forestrie-Grant <base64>` (the same grant-as-credential transport
 * register-grant / register-signed-statement use); no request body is required.
 *
 * ## Security core (the whole point)
 *
 * Authority is the parent log's `K(L)` — the create grant's COSE_Sign1 envelope
 * signer — and **never** an operator onboard token. We resolve the parent authority
 * key and verify the create grant's envelope against it:
 *
 *  - **Parent is the forest root** (`ownerLogId` has a stored genesis whose bootstrap
 *    log id equals it): verify against the genesis bootstrap key. This is where the
 *    recursion bottoms out.
 *  - **Parent is an intermediate child**: resolve the parent's registered root key
 *    from the coordinator (`GET /api/logs/{ownerLogId}/public-root`, via
 *    trust-root-client) and verify against it. The parent's own root was registered
 *    (auto-forward or a prior prepare) and verified against *its* parent — a
 *    recursive chain terminating at the root genesis. If the parent has no registered
 *    public root, onboarding must start higher up: `409`.
 *
 * The envelope crypto mirrors register-grant's creation path (which delegates to
 * univocity's "verify COSE envelope against the owner authority key" step) and the
 * local `verifyDerivedEndorsementEnvelope` helper: COSE_Sign1 over the 32-byte grant
 * digest, ES256.
 */

import {
  verifyCoseSign1WithParsedKey,
  type ParsedVerifyKey,
} from "@forestrie/encoding";

import { cborResponse } from "../cbor-api/cbor-response.js";
import { bytesEqual } from "../cbor-api/cbor-map-utils.js";
import { ClientErrors, ServerErrors } from "../cbor-api/problem-details.js";
import { COSE_ALG_ES256, COSE_ALG_KS256 } from "../cose/cose-key.js";
import {
  createCoordinatorPublicTrustRootClient,
  isTrustRootNotFound,
  type RootVerifyKey,
} from "../env/trust-root-client.js";
import { getGrantFromRequest } from "../scrapi/auth-grant.js";
import { verifyKs256CoseSign1 } from "../grant/ks256-verify.js";
import { isParsedKs256RootKey } from "../grant/parsed-ks256-root-key.js";
import { verifyGrantCoseSign1WithGrantDataXy } from "../scrapi/custodian-grant.js";
import { hasCreateAndExtend } from "../grant/grant-flags.js";
import { grantDataToBytes } from "../grant/grant-data.js";
import { logIdBytesToCustodianLowerHex } from "../grant/uuid-bytes.js";
import {
  logIdToStorageSegment,
  logIdToWireBytes,
} from "../grant/log-id-wire.js";
import type { Grant, GrantResult } from "../grant/types.js";
import { getParsedGenesis, type ParsedForestGenesis } from "./genesis-cache.js";
import {
  forwardCoordinatorRegistration,
  isCoordinatorForwardConfigured,
  type CoordinatorForwardEnv,
} from "./forward-coordinator-registration.js";
import {
  GenesisWebhookUrlValidationError,
  validateGenesisWebhookUrl,
} from "./validate-genesis-webhook-url.js";

export interface PrepareChildLogEnv extends CoordinatorForwardEnv {
  /** Genesis lookup bucket (resolves whether the parent is the forest root). */
  R2_GRANTS: R2Bucket;
  /** Gates insecure-local webhook URLs when `"dev"`. */
  NODE_ENV?: string;
}

/**
 * Verify the create grant's COSE envelope against the genesis bootstrap authority
 * key (parent == forest root). Mirrors {@link verifyDerivedEndorsementEnvelope}.
 */
async function verifyGrantAgainstGenesisKey(
  grantBytes: Uint8Array,
  genesis: ParsedForestGenesis,
): Promise<boolean> {
  if (genesis.bootstrapAlg != null && genesis.bootstrapKey) {
    if (
      genesis.bootstrapAlg === COSE_ALG_ES256 &&
      genesis.bootstrapKey.length === 64
    ) {
      return verifyGrantCoseSign1WithGrantDataXy(
        grantBytes,
        genesis.bootstrapKey,
      );
    }
    if (
      genesis.bootstrapAlg === COSE_ALG_KS256 &&
      genesis.bootstrapKey.length === 20
    ) {
      return verifyKs256CoseSign1(grantBytes, {
        kind: "KS256",
        alg: COSE_ALG_KS256,
        address: genesis.bootstrapKey,
      });
    }
    return false;
  }
  if (genesis.x && genesis.y) {
    const xy = new Uint8Array(64);
    xy.set(genesis.x, 0);
    xy.set(genesis.y, 32);
    return verifyGrantCoseSign1WithGrantDataXy(grantBytes, xy);
  }
  return false;
}

/**
 * Resolve the parent authority key for `grant.ownerLogId` and verify the create
 * grant's envelope against it. Returns `true` on a valid signature; otherwise a
 * `Response` describing the failure (400/403/409/503).
 */
async function verifyCreateGrantAgainstParent(
  grantResult: GrantResult,
  grant: Grant,
  env: PrepareChildLogEnv,
): Promise<true | Response> {
  const grantBytes = grantResult.bytes;
  if (!grantBytes?.length) {
    return ClientErrors.badRequest("Create grant is missing raw bytes.");
  }

  // Parent == forest root? A stored genesis whose bootstrap log id equals the
  // owner log id is the terminal authority (recursion bottoms out here).
  const ownerSeg = logIdToStorageSegment(grant.ownerLogId);
  const genesisLookup = await getParsedGenesis(ownerSeg, {
    R2_GRANTS: env.R2_GRANTS,
  });
  if (!("kind" in genesisLookup)) {
    const ok = await verifyGrantAgainstGenesisKey(grantBytes, genesisLookup);
    if (!ok) {
      return ClientErrors.forbidden(
        "Create grant signature did not verify against the forest root genesis authority key.",
      );
    }
    return true;
  }
  if (genesisLookup.kind === "corrupt") {
    return ServerErrors.internal(
      "Stored genesis for the parent forest is invalid.",
    );
  }

  // Parent is an intermediate child log: resolve its registered root key from the
  // coordinator public-root. A missing public root means the parent was never
  // onboarded — start higher up the hierarchy.
  const parentHex32 = logIdBytesToCustodianLowerHex(grant.ownerLogId);
  let parentKey: RootVerifyKey;
  try {
    const client = createCoordinatorPublicTrustRootClient({
      coordinatorBaseUrl: env.DELEGATION_COORDINATOR_URL!.trim(),
      token: env.COORDINATOR_APP_TOKEN!.trim(),
    });
    parentKey = await client.logSigningKey(parentHex32);
  } catch (e) {
    if (isTrustRootNotFound(e)) {
      return ClientErrors.conflict(
        "Parent log has no registered public root; onboard the parent (prepare or create) before its children.",
      );
    }
    const msg = e instanceof Error ? e.message : String(e);
    console.warn("prepare: parent public-root resolve failed", e);
    return ServerErrors.serviceUnavailable(
      msg.length > 200 ? `${msg.slice(0, 200)}…` : msg,
    );
  }

  if (isParsedKs256RootKey(parentKey)) {
    return ClientErrors.forbidden(
      "Parent authority key is KS256; child create grants require an ES256 parent root.",
    );
  }
  const ok = await verifyCoseSign1WithParsedKey(
    grantBytes,
    parentKey satisfies ParsedVerifyKey,
  );
  if (!ok) {
    return ClientErrors.forbidden(
      "Create grant signature did not verify against the parent log's registered root key.",
    );
  }
  return true;
}

function parsePrepareWebhookUrl(
  request: Request,
  env: PrepareChildLogEnv,
): { webhookUrl?: string } | Response {
  const raw = new URL(request.url).searchParams.get("webhookUrl");
  if (raw === null || raw.trim() === "") return {};
  try {
    return {
      webhookUrl: validateGenesisWebhookUrl(raw, {
        allowInsecureLocal: env.NODE_ENV === "dev",
      }),
    };
  } catch (error) {
    const detail =
      error instanceof GenesisWebhookUrlValidationError
        ? error.message
        : "Invalid webhookUrl";
    return ClientErrors.badRequest(detail);
  }
}

/**
 * Handle `POST /api/forest/{childLogId}/prepare`. See the module doc for the
 * authority model. `childLogIdSeg` is the raw path segment.
 */
export async function handlePrepareChildLog(
  request: Request,
  childLogIdSeg: string,
  env: PrepareChildLogEnv,
): Promise<Response> {
  if (!isCoordinatorForwardConfigured(env)) {
    return ServerErrors.serviceUnavailable(
      "prepare requires delegation coordinator configuration (DELEGATION_COORDINATOR_URL and COORDINATOR_APP_TOKEN).",
    );
  }

  // Credential: parent-signed create grant in Authorization: Forestrie-Grant.
  const grantResult = getGrantFromRequest(request);
  if (grantResult instanceof Response) return grantResult;
  const grant = grantResult.grant;
  const grantFlags = grant.grant as Uint8Array;

  if (!hasCreateAndExtend(grantFlags)) {
    return ClientErrors.badRequest(
      "prepare requires a create-log grant (GF_CREATE|GF_EXTEND).",
    );
  }

  let childLogId: Uint8Array;
  try {
    childLogId = logIdToWireBytes(childLogIdSeg);
  } catch {
    return ClientErrors.badRequest("Invalid child log-id in path.");
  }
  if (!bytesEqual(childLogId, grant.logId)) {
    return ClientErrors.badRequest(
      "Create grant logId does not match {childLogId} in the path.",
    );
  }
  // A child grant names a distinct parent authority; the self-referential root
  // grant belongs to POST /api/forest/{R}/genesis, not prepare.
  if (bytesEqual(grant.logId, grant.ownerLogId)) {
    return ClientErrors.badRequest(
      "prepare is for child grants (logId != ownerLogId); onboard the forest root via genesis.",
    );
  }

  let childOwnerKey: Uint8Array;
  try {
    childOwnerKey = grantDataToBytes(grant.grantData);
  } catch {
    return ClientErrors.badRequest("Create grant grantData is unreadable.");
  }
  if (childOwnerKey.length !== 64) {
    return ClientErrors.badRequest(
      "Create grant grantData must be a 64-byte ES256 x||y child owner key.",
    );
  }

  // Security core: verify the create grant against the parent authority key.
  const verified = await verifyCreateGrantAgainstParent(
    grantResult,
    grant,
    env,
  );
  if (verified instanceof Response) return verified;

  const webhookParsed = parsePrepareWebhookUrl(request, env);
  if (webhookParsed instanceof Response) return webhookParsed;

  const status = await forwardCoordinatorRegistration({
    coordinatorBaseUrl: env.DELEGATION_COORDINATOR_URL!.trim(),
    coordinatorAppToken: env.COORDINATOR_APP_TOKEN!.trim(),
    logIdWire: grant.logId,
    genesisAlg: COSE_ALG_ES256,
    bootstrapKey: childOwnerKey,
    webhookUrl: webhookParsed.webhookUrl,
  });

  if (status.publicRoot !== "ok") {
    return ServerErrors.serviceUnavailable(
      status.detail ??
        `coordinator public-root registration failed (publicRoot=${status.publicRoot})`,
    );
  }
  if (webhookParsed.webhookUrl && status.webhook !== "ok") {
    return ServerErrors.serviceUnavailable(
      status.detail ??
        `coordinator webhook registration failed (webhook=${status.webhook})`,
    );
  }

  return cborResponse(
    {
      publicRoot: status.publicRoot,
      webhook: status.webhook,
      ...(status.detail ? { detail: status.detail } : {}),
    },
    201,
  );
}
