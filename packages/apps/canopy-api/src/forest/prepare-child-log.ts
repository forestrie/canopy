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
 * ## Security core: claim through univocity first
 *
 * Authority is the parent log's `K(L)` — the create grant's COSE_Sign1 envelope
 * signer — and **never** an operator onboard token. canopy-api does not hold
 * that key: it reserves the child through univocity (`POST /api/grants`,
 * intent `reserve`), which verifies the envelope against the owner's root key
 * (on chain once the owner has checkpointed, else its stored grant chain
 * anchored at the bootstrap key; EOA or ERC-1271), claims `logId -> R`, and
 * stores the grant write-once. Only an accepted claim reaches the coordinator,
 * so no owner can replace another log's root, and a different grant for a
 * claimed child is univocity's 409
 * ([devdocs ADR-0075](https://github.com/forestrie/devdocs/blob/main/adr/adr-0075-sec-child-root-claimed-once.md)
 * decisions 1-3).
 *
 * A reservation confers no authority (protocol ADR-0070), so `prepare` is
 * allowed under a pending owner. It lapses at `expiresAt` unless create
 * commits the grant; a re-post refreshes it. The root is forwarded with that
 * lapse time, so the coordinator's root lapses with the claim.
 *
 * ## KS256 (ADR-0053 amendment 2026-10-18)
 *
 * The child root may be a 64-byte ES256 key or a 20-byte KS256 address
 * (grantData length decides, {@link childRootForwardFromGrantData}). The
 * forward carries the forest's chain, from univocity's answer for the owner,
 * so the child's own delegations can be checked by ERC-1271 on that chain.
 */

import { cborResponse } from "../cbor-api/cbor-response.js";
import { bytesEqual } from "../cbor-api/cbor-map-utils.js";
import { ClientErrors, ServerErrors } from "../cbor-api/problem-details.js";
import type { LogAuthorityReader } from "../env/log-authority-reader.js";
import { getGrantFromRequest } from "../scrapi/auth-grant.js";
import { authorityConflictResponse } from "../scrapi/log-admission.js";
import { reserveChildGrantWithUnivocity } from "../scrapi/univocity-grant-client.js";
import { hasCreateAndExtend } from "../grant/grant-flags.js";
import { grantDataToBytes } from "../grant/grant-data.js";
import { bytesToUuid } from "../grant/uuid-bytes.js";
import { logIdToWireBytes } from "../grant/log-id-wire.js";
import { childRootForwardFromGrantData } from "./child-root-forward.js";
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

export interface PrepareChildLogEnv extends CoordinatorForwardEnv {
  /** Registration lookup bucket (the parent's univocity instance binding). */
  R2_GRANTS: R2Bucket;
  /** Gates insecure-local webhook URLs when `"dev"`. */
  NODE_ENV?: string;
  /** univocity base URL and bearer: the child is reserved there first. */
  UNIVOCITY_SERVICE_URL?: string;
  UNIVOCITY_API_TOKEN?: string;
  /** univocity's log authority: the owner's chain, and conflicted owners. */
  logAuthority?: LogAuthorityReader;
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
 *
 * Answers 201 when univocity created the reservation and 200 for the same
 * grant again; either carries `expiresAt` unless the grant is already
 * committed. univocity's 409 (a different grant for the child) and 4xx (403
 * here) are passed back with nothing forwarded.
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
  const univocityUrl = env.UNIVOCITY_SERVICE_URL?.trim();
  const univocityToken = env.UNIVOCITY_API_TOKEN?.trim();
  if (!univocityUrl || !univocityToken || !env.logAuthority) {
    return ServerErrors.serviceUnavailable(
      "prepare requires univocity (UNIVOCITY_SERVICE_URL and UNIVOCITY_API_TOKEN).",
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
  if (!grantResult.bytes?.length) {
    return ClientErrors.badRequest("Create grant is missing raw bytes.");
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

  // Validate everything the caller sent before claiming, so a bad request
  // never leaves a reservation behind.
  const webhookParsed = parsePrepareWebhookUrl(request, env);
  if (webhookParsed instanceof Response) return webhookParsed;

  // The owner's answer gives the forest's chain for the forward. A pending
  // owner may take reservations; a conflicted one never anchors anything.
  const owner = await env.logAuthority.read(grant.ownerLogId);
  switch (owner.kind) {
    case "conflicted":
      return authorityConflictResponse(grant.ownerLogId, owner.blockedBy);
    case "unclaimed":
      return ClientErrors.conflict(
        `Parent log ${bytesToUuid(grant.ownerLogId)} has no claim; onboard the parent (prepare or create) before its children.`,
      );
    case "unavailable":
      return ServerErrors.serviceUnavailable(
        `Log authority is unavailable: ${owner.detail}`,
      );
  }
  const chainBinding = owner.chainId ? { chainId: owner.chainId } : undefined;

  // Security core: univocity verifies the grant against the owner's key and
  // reserves the child. Nothing reaches the coordinator unless it accepts.
  const claim = await reserveChildGrantWithUnivocity(
    { serviceUrl: univocityUrl, token: univocityToken },
    grantResult.bytes,
  );
  switch (claim.kind) {
    case "conflict":
      return ClientErrors.conflict(
        `Univocity refused the claim (${claim.title || "conflict"}): ${claim.detail || "the child is already claimed by a different grant or forest."}`,
      );
    case "rejected":
      return ClientErrors.forbidden(
        claim.detail ||
          "Univocity rejected the create grant (it does not verify against the owner's key).",
      );
    case "unavailable":
      return ServerErrors.serviceUnavailable(
        claim.detail || "Univocity grant claims are unavailable.",
      );
  }

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
    ...(claim.expiresAt !== undefined ? { expiresAt: claim.expiresAt } : {}),
    ...(webhookParsed.webhookUrl
      ? { webhookUrl: webhookParsed.webhookUrl }
      : {}),
    ...(univocityInstanceId ? { univocityInstanceId } : {}),
  });

  if (status.publicRoot === "conflict") {
    return ClientErrors.conflict(
      status.detail ?? "The coordinator holds a different root for this log.",
    );
  }
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
      state: claim.state,
      ...(claim.expiresAt !== undefined ? { expiresAt: claim.expiresAt } : {}),
      ...(status.univocityInstanceId
        ? { univocityInstanceId: status.univocityInstanceId }
        : {}),
      ...(status.detail ? { detail: status.detail } : {}),
    },
    claim.created ? 201 : 200,
  );
}
