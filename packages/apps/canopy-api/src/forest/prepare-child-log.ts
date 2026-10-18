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
 * digest, ES256 or KS256 by the parent root's alg.
 *
 * ## KS256 (ADR-0053 amendment 2026-10-18, plan-2610-03 D2, D3, D6)
 *
 * The child root may be a 64-byte ES256 key or a 20-byte KS256 address
 * (grantData length decides, {@link childRootForwardFromGrantData}). A KS256
 * parent, EOA or contract, verifies by `keccak256(Sig_structure)`: ecrecover,
 * or ERC-1271 `isValidSignature` over the RPC `SUPPORTED_CHAINS_RPC` gives for
 * the forest's chain. The chain is the genesis chain binding on the root path
 * and the `chainId` the coordinator holds for the parent's root otherwise, and
 * the child's forward carries it on so its own children can do the same. An RPC
 * failure is 503; without RPC for the chain only ecrecover runs, so a contract
 * parent gets a 403 that says so.
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
  type RegisteredPublicRoot,
} from "../env/trust-root-client.js";
import {
  rpcUrlsForEnvChainId,
  type SupportedChainsEnv,
} from "../env/supported-chains-for-env.js";
import { Erc1271UnavailableError } from "@forestrie/chain-rpc";
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
  childRootForwardFromGrantData,
  forwardChainBindingFromGenesis,
  type ForwardChainBinding,
} from "./child-root-forward.js";
import {
  forwardCoordinatorRegistration,
  isCoordinatorForwardConfigured,
  type CoordinatorForwardEnv,
} from "./forward-coordinator-registration.js";
import {
  GenesisWebhookUrlValidationError,
  validateGenesisWebhookUrl,
} from "./validate-genesis-webhook-url.js";
import { tryUnivocityInstanceIdFromChainBinding } from "@canopy/univocity-instance-id";
import { readRegistration } from "../payments/registration-store.js";

export interface PrepareChildLogEnv
  extends CoordinatorForwardEnv,
    SupportedChainsEnv {
  /** Genesis lookup bucket (resolves whether the parent is the forest root). */
  R2_GRANTS: R2Bucket;
  /** Gates insecure-local webhook URLs when `"dev"`. */
  NODE_ENV?: string;
}

/**
 * Verify the create grant's COSE envelope against the genesis bootstrap authority
 * key (parent == forest root). Mirrors {@link verifyDerivedEndorsementEnvelope}.
 * The genesis `bootstrapAlg` decides the key type and the key length must agree
 * with it (D6); a KS256 root verifies on the genesis chain binding's chain.
 */
async function verifyGrantAgainstGenesisKey(
  grantBytes: Uint8Array,
  genesis: ParsedForestGenesis,
  env: SupportedChainsEnv,
): Promise<true | Response> {
  const authority = "the forest root genesis authority key";
  if (genesis.bootstrapAlg != null && genesis.bootstrapKey) {
    if (
      genesis.bootstrapAlg === COSE_ALG_ES256 &&
      genesis.bootstrapKey.length === 64
    ) {
      const ok = await verifyGrantCoseSign1WithGrantDataXy(
        grantBytes,
        genesis.bootstrapKey,
      );
      return ok || forbiddenDidNotVerify(authority);
    }
    if (
      genesis.bootstrapAlg === COSE_ALG_KS256 &&
      genesis.bootstrapKey.length === 20
    ) {
      return verifyGrantAgainstKs256Parent(
        grantBytes,
        genesis.bootstrapKey,
        genesis.chainBinding?.chainId,
        env,
        authority,
      );
    }
    return forbiddenDidNotVerify(authority);
  }
  if (genesis.x && genesis.y) {
    const xy = new Uint8Array(64);
    xy.set(genesis.x, 0);
    xy.set(genesis.y, 32);
    const ok = await verifyGrantCoseSign1WithGrantDataXy(grantBytes, xy);
    return ok || forbiddenDidNotVerify(authority);
  }
  return forbiddenDidNotVerify(authority);
}

/**
 * Verify a create grant signed by a KS256 parent root (D3), with the existing
 * {@link verifyKs256CoseSign1}: ERC-1271 when the address has code on `chainId`
 * and RPC is configured for it, else ecrecover.
 *
 * @param chainId — the forest's EIP-155 chain; undefined when unknown, which
 *   leaves only ecrecover.
 * @returns `true`, 503 when the chain RPC fails (retryable, never a verdict),
 *   or 403. With no RPC the 403 says a contract parent cannot be verified.
 */
async function verifyGrantAgainstKs256Parent(
  grantBytes: Uint8Array,
  address: Uint8Array,
  chainId: string | undefined,
  env: SupportedChainsEnv,
  authority: string,
): Promise<true | Response> {
  const rpcUrls = chainId ? (rpcUrlsForEnvChainId(env, chainId) ?? []) : [];
  let ok: boolean;
  try {
    ok = await verifyKs256CoseSign1(
      grantBytes,
      { kind: "KS256", alg: COSE_ALG_KS256, address },
      {
        rpcUrls,
        throwOnUnavailable: true,
        logFailures: true,
        logPrefix: "prepare-ks256-parent",
      },
    );
  } catch (e) {
    if (e instanceof Erc1271UnavailableError) {
      return ServerErrors.serviceUnavailable(
        "ERC-1271 verification of the KS256 parent root is unavailable; retry.",
      );
    }
    throw e;
  }
  if (ok) return true;
  if (rpcUrls.length === 0) {
    const chain = chainId
      ? `chain ${chainId}`
      : "the parent's chain (none is registered for its root)";
    return ClientErrors.forbidden(
      `Create grant signature did not verify against ${authority} by ecrecover. No RPC is configured for ${chain}, so a contract (ERC-1271) parent cannot be verified.`,
    );
  }
  return forbiddenDidNotVerify(authority);
}

function forbiddenDidNotVerify(authority: string): Response {
  return ClientErrors.forbidden(
    `Create grant signature did not verify against ${authority}.`,
  );
}

/**
 * Resolve the parent authority key for `grant.ownerLogId` and verify the create
 * grant's envelope against it. On a valid signature, returns the forest's chain
 * binding as far as it is known here, for the child's forward; otherwise a
 * `Response` describing the failure (400/403/409/503).
 */
async function verifyCreateGrantAgainstParent(
  grantResult: GrantResult,
  grant: Grant,
  env: PrepareChildLogEnv,
): Promise<{ chainBinding?: ForwardChainBinding } | Response> {
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
    const verified = await verifyGrantAgainstGenesisKey(
      grantBytes,
      genesisLookup,
      env,
    );
    if (verified !== true) return verified;
    return {
      chainBinding: forwardChainBindingFromGenesis(genesisLookup.chainBinding),
    };
  }
  if (genesisLookup.kind === "corrupt") {
    return ServerErrors.internal(
      "Stored genesis for the parent forest is invalid.",
    );
  }

  // Parent is an intermediate child log: resolve its registered root key, and
  // the chain the coordinator holds for it, from the coordinator public-root. A
  // missing public root means the parent was never onboarded — start higher up
  // the hierarchy.
  const parentHex32 = logIdBytesToCustodianLowerHex(grant.ownerLogId);
  let parentRoot: RegisteredPublicRoot;
  try {
    const client = createCoordinatorPublicTrustRootClient({
      coordinatorBaseUrl: env.DELEGATION_COORDINATOR_URL!.trim(),
      token: env.COORDINATOR_APP_TOKEN!.trim(),
    });
    parentRoot = await client.logPublicRoot(parentHex32);
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

  const { key: parentKey, chainId } = parentRoot;
  const chainBinding = chainId ? { chainId } : undefined;
  const authority = "the parent log's registered root key";
  if (isParsedKs256RootKey(parentKey)) {
    const verified = await verifyGrantAgainstKs256Parent(
      grantBytes,
      parentKey.address,
      chainId,
      env,
      authority,
    );
    if (verified !== true) return verified;
    return { chainBinding };
  }
  const ok = await verifyCoseSign1WithParsedKey(
    grantBytes,
    parentKey satisfies ParsedVerifyKey,
  );
  if (!ok) return forbiddenDidNotVerify(authority);
  return { chainBinding };
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

  let grantData: Uint8Array;
  try {
    grantData = grantDataToBytes(grant.grantData);
  } catch {
    return ClientErrors.badRequest("Create grant grantData is unreadable.");
  }
  const childRoot = childRootForwardFromGrantData(grantData);
  if (!childRoot) {
    return ClientErrors.badRequest(
      "Create grant grantData must be a 64-byte ES256 x||y key or a 20-byte KS256 address.",
    );
  }

  // Security core: verify the create grant against the parent authority key.
  const verified = await verifyCreateGrantAgainstParent(
    grantResult,
    grant,
    env,
  );
  if (verified instanceof Response) return verified;
  const { chainBinding } = verified;

  const webhookParsed = parsePrepareWebhookUrl(request, env);
  if (webhookParsed instanceof Response) return webhookParsed;

  // Only the root registers a webhook of its own (the genesis-only forward), so
  // a child would otherwise have none at all. Binding the child to its parent's
  // univocity instance makes the instance webhook be copied into the child's
  // config row, with no per-child registration (ADR-0053 amendment, FOR-468).
  // The parent's registration record is what carries the chain binding; a
  // parent without one leaves the child with no instance, which is supported —
  // the owner then pre-supplies the delegation.
  const parentRegistration = await readRegistration(env, grant.ownerLogId);
  const univocityInstanceId = parentRegistration
    ? tryUnivocityInstanceIdFromChainBinding(parentRegistration.chainBinding)
    : undefined;

  const status = await forwardCoordinatorRegistration({
    coordinatorBaseUrl: env.DELEGATION_COORDINATOR_URL!.trim(),
    coordinatorAppToken: env.COORDINATOR_APP_TOKEN!.trim(),
    logIdWire: grant.logId,
    ...childRoot,
    ...(chainBinding ? { chainBinding } : {}),
    ...(webhookParsed.webhookUrl
      ? { webhookUrl: webhookParsed.webhookUrl }
      : {}),
    ...(univocityInstanceId ? { univocityInstanceId } : {}),
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
      ...(status.univocityInstanceId
        ? { univocityInstanceId: status.univocityInstanceId }
        : {}),
      ...(status.detail ? { detail: status.detail } : {}),
    },
    201,
  );
}
