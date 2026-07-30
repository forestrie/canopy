/**
 * `/api/onboarding/**` — self-service onboard request + ops admin JSON.
 */

import { decodeCborDeterministic } from "@forestrie/encoding";
import {
  adminJsonResponse,
  asAdminJsonResponse,
  problemResponseToAdminJson,
} from "../cbor-api/admin-json-response.js";
import { parseCborBody } from "../cbor-api/cbor-request.js";
import {
  cborResponse,
  problemResponse,
  requireContentTypeCbor,
} from "../cbor-api/cbor-response.js";
import { ClientErrors, ServerErrors } from "../cbor-api/problem-details.js";
import { decodeBodyAsIntKeyMap } from "../cbor-api/cbor-map-utils.js";
import { opsAdminBearerOrUnauthorized } from "../payments/bearer-auth.js";
import {
  listOnboardTokens,
  mintOnboardToken,
  readOnboardTokenRecord,
  revokeOnboardToken,
  revokeOtherActiveTokensForRequest,
  type OnboardTokenStoreEnv,
} from "../payments/onboard-token-store.js";
import { shouldAutoApproveRequest } from "./onboard-auto-approve.js";
import { tryUnivocityInstanceIdFromChainBinding } from "@canopy/univocity-instance-id";
import {
  requestHolder,
  reserveUnivocityInstance,
} from "../payments/instance-registry.js";
import {
  checkOnboardCreateBodySize,
  checkOnboardCreateRateLimit,
  checkOnboardFieldLengths,
  checkOnboardRedeemRateLimit,
  checkOnboardRejectReasonLength,
} from "./onboard-create-guard.js";
import { scheduleOnboardWebhook } from "./onboard-notify.js";
import { redeemOrStatusHttpError } from "./onboard-request-http.js";
import type { OnboardRequestRecord } from "./onboard-request-record.js";
import {
  countNonTerminalRequestsForBinding,
  createOnboardRequest,
  effectiveStatus,
  listOnboardRequests,
  readOnboardRequest,
  readOnboardRequestWithEtag,
  writeOnboardRequestCas,
  transitionApprovedToRedeemedCas,
  transitionPendingToApprovedCas,
  transitionPendingToRejectedCas,
  verifyRedeemCode,
  writeOnboardRequest,
  type OnboardRequestStoreEnv,
} from "./onboard-request-store.js";
import {
  attestationVerifyCapabilities,
  verifyUnivocityDeployment,
} from "./univocity-deployment-gate.js";
import type { UnivocityGateEnv } from "./univocity-deployment-gate.js";
import {
  DEFAULT_ATTESTATION_MAX_WINDOW_SEC,
  verifyOnboardAttestation,
} from "./onboard-attestation.js";
import type { SettlementJob } from "@canopy/x402-settlement-types";
import {
  verifyOnboardPayment,
  claimPaymentAuthorization,
  buildOnboardSettlementJob,
  enqueueOnboardSettlement,
  onboardPaymentRequiredHeader,
  X402_HEADERS,
  type OnboardPaymentEnv,
} from "./onboard-payment.js";

const CBOR_LABEL = 1;
const CBOR_CHAIN_ID = 2;
const CBOR_UNIVOCITY_ADDR = 3;
const CBOR_CONTACT_EMAIL = 4;
const CBOR_MANDATE_ORIGIN = 5;
const CBOR_PLANNED_FOREST_R = 6;
/** COSE_Sign1 bootstrap-key attestation bytes (slice 06, ADR-0059 D8). */
const CBOR_ATTESTATION = 7;
const CBOR_REDEEM_CODE = 1;
const CBOR_REJECT_REASON = 1;

const NO_STORE_HEADERS = { "cache-control": "no-store" };

/**
 * 402 with the onboard `X-PAYMENT-REQUIRED` challenge header.
 *
 * Uses the repo's `problemResponse` helper so the error shape matches the rest
 * of this (CBOR) API; the x402 challenge itself travels in the header, not the
 * body, so the body encoding is free to follow local convention.
 */
function paymentRequiredResponse(
  env: OnboardPaymentEnv,
  resourceUrl: string,
  reason?: string,
): Response {
  return problemResponse(402, "Payment Required", "about:blank", {
    detail: reason ?? "Payment required to redeem this onboard request",
    headers: {
      ...NO_STORE_HEADERS,
      [X402_HEADERS.paymentRequired]: onboardPaymentRequiredHeader(
        env,
        resourceUrl,
      ),
    },
  });
}

export interface OnboardingHandlerEnv
  extends OnboardRequestStoreEnv,
    OnboardTokenStoreEnv,
    OnboardPaymentEnv,
    UnivocityGateEnv {
  NODE_ENV?: string;
  CANOPY_OPS_ADMIN_TOKEN?: string;
  ONBOARD_REQUEST_TTL_SEC?: string;
  ONBOARD_TOKEN_TTL_SEC?: string;
  ONBOARD_MAX_PENDING_PER_BINDING?: string;
  ONBOARD_RPC_TIMEOUT_MS?: string;
  ONBOARD_GATE_CACHE_TTL_SEC?: string;
  ONBOARD_REQUEST_WEBHOOK_URL?: string;
  ONBOARD_REQUEST_WEBHOOK_SECRET?: string;
  ONBOARD_AUTO_APPROVE?: string;
  ONBOARD_AUTO_APPROVE_CHAIN_IDS?: string;
  ONBOARD_AUTO_APPROVE_LABEL_PREFIX?: string;
  /** Slice-06 flag (ADR-0059 D8): require the bootstrap-key attestation. */
  ONBOARD_REQUIRE_KEY_ATTESTATION?: string;
  /** Accepted attestation `aud` override (request origin always accepted). */
  ONBOARD_ATTESTATION_AUD?: string;
  /** Ceiling on attestation exp-iat (seconds; default 86400). */
  ONBOARD_ATTESTATION_MAX_WINDOW_SEC?: string;
  /**
   * Admission policy (ADR-0059 decision 3): `vetted` — ops approval only,
   * payment never solicited; `paid` / `either` — a pending request may be
   * approved by paying at redeem. Defaults to `either`.
   */
  ONBOARD_ADMISSION?: string;
  ONBOARD_CREATE_RATE_LIMITER?: {
    limit(options: { key: string }): Promise<{ success: boolean }>;
  };
}

function attachCors(
  res: Response,
  corsHeaders: Record<string, string>,
): Response {
  const headers = new Headers(res.headers);
  for (const [k, v] of Object.entries(corsHeaders)) {
    headers.set(k, v);
  }
  return new Response(res.body, {
    status: res.status,
    statusText: res.statusText,
    headers,
  });
}

function defaultRequestTtlSec(env: OnboardingHandlerEnv): number {
  const raw = env.ONBOARD_REQUEST_TTL_SEC?.trim();
  if (raw) {
    const n = Number.parseInt(raw, 10);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return 604_800;
}

function defaultTokenTtlSec(env: OnboardingHandlerEnv): number {
  const raw = env.ONBOARD_TOKEN_TTL_SEC?.trim();
  if (raw) {
    const n = Number.parseInt(raw, 10);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return 604_800;
}

type OnboardAdmission = "vetted" | "paid" | "either";

/**
 * A set-but-unrecognised value is a misconfiguration, not a default: silently
 * falling back to `either` would open payment on a deployment that intended
 * `vetted` (plan-2607-02 F7). Fail closed, loudly.
 */
function onboardAdmission(
  env: OnboardingHandlerEnv,
): OnboardAdmission | Response {
  const raw = env.ONBOARD_ADMISSION?.trim().toLowerCase();
  if (!raw || raw === "either") return "either";
  if (raw === "vetted" || raw === "paid") return raw;
  return problemResponse(500, "Internal Server Error", "about:blank", {
    detail: "ONBOARD_ADMISSION must be one of vetted, paid, either",
  });
}

/**
 * Reserve the request's univocity instance for this request (ADR-0059
 * decision 8): the reservation is taken at the admission moment, before any
 * approval transition or mint, so a conflict can never consume a paid
 * credential. Idempotent for this request's own retries. The 409 is
 * deliberately anonymous — a foreign holder's requestId is not the caller's
 * to learn; the ops chain-bindings route carries the detail.
 */
async function reserveForRequest(
  env: OnboardingHandlerEnv,
  record: OnboardRequestRecord,
): Promise<Response | null> {
  const univocityInstanceId = tryUnivocityInstanceIdFromChainBinding(
    record.chainBinding,
  );
  if (!univocityInstanceId) {
    return problemResponse(500, "Internal Server Error", "about:blank", {
      detail:
        "onboard request chain binding cannot render a univocity instance id",
    });
  }
  const reserved = await reserveUnivocityInstance(
    env,
    univocityInstanceId,
    requestHolder(record.requestId),
  );
  if (!reserved.ok) {
    return ClientErrors.conflict(
      "Univocity instance is already reserved or registered",
    );
  }
  return null;
}

function maxPendingPerBinding(env: OnboardingHandlerEnv): number {
  const raw = env.ONBOARD_MAX_PENDING_PER_BINDING?.trim();
  if (raw) {
    const n = Number.parseInt(raw, 10);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return 3;
}

function parseListPagination(url: string): { limit: number; cursor?: string } {
  const params = new URL(url).searchParams;
  const limitRaw = params.get("limit");
  let limit = 100;
  if (limitRaw) {
    const n = Number.parseInt(limitRaw, 10);
    if (Number.isFinite(n) && n > 0) limit = Math.min(n, 1000);
  }
  const cursor = params.get("cursor")?.trim() || undefined;
  return { limit, cursor };
}

function publicRequestView(record: OnboardRequestRecord) {
  return {
    requestId: record.requestId,
    status: effectiveStatus(record),
    label: record.label,
    chainBinding: record.chainBinding,
    createdAt: record.createdAt,
    expiresAt: record.expiresAt,
    mandateOrigin: record.mandateOrigin,
    plannedForestR: record.plannedForestR,
    onboardTokenRef: record.onboardTokenRef,
  };
}

async function pendingTransitionConflict(
  env: OnboardingHandlerEnv,
  requestId: string,
): Promise<Response> {
  const reread = await readOnboardRequest(env, requestId);
  if (!reread) {
    return ClientErrors.notFound("Not Found", "Request not found");
  }
  if (effectiveStatus(reread) !== "pending") {
    return ClientErrors.conflict("Request is not pending");
  }
  return ClientErrors.conflict("Request is not pending");
}

async function approveRequestRecord(
  env: OnboardingHandlerEnv,
  requestId: string,
): Promise<OnboardRequestRecord | Response> {
  const transition = await transitionPendingToApprovedCas(env, requestId);
  if (transition.ok) return transition.record;
  if (transition.reason === "not_found") {
    return ClientErrors.notFound("Not Found", "Request not found");
  }
  return pendingTransitionConflict(env, requestId);
}

async function handleCreateRequest(
  request: Request,
  env: OnboardingHandlerEnv,
  corsHeaders: Record<string, string>,
  ctx: ExecutionContext,
): Promise<Response> {
  const rateLimited = await checkOnboardCreateRateLimit(request, env);
  if (rateLimited) return attachCors(rateLimited, corsHeaders);

  const ctErr = requireContentTypeCbor(request);
  if (ctErr) return attachCors(ctErr, corsHeaders);

  let label: string | undefined;
  let chainId: string | undefined;
  let univocityAddr: string | undefined;
  let contactEmail: string | undefined;
  let mandateOrigin: string | undefined;
  let plannedForestR: string | undefined;
  let attestation: Uint8Array | undefined;

  try {
    const bodyBytes = new Uint8Array(await request.arrayBuffer());
    const sizeErr = checkOnboardCreateBodySize(request, bodyBytes.length);
    if (sizeErr) return attachCors(sizeErr, corsHeaders);

    const raw = decodeCborDeterministic(bodyBytes);
    const m = decodeBodyAsIntKeyMap(raw);
    if (m) {
      label = readString(m, CBOR_LABEL);
      chainId = readString(m, CBOR_CHAIN_ID);
      univocityAddr = readString(m, CBOR_UNIVOCITY_ADDR);
      contactEmail = readString(m, CBOR_CONTACT_EMAIL);
      mandateOrigin = readString(m, CBOR_MANDATE_ORIGIN);
      plannedForestR = readString(m, CBOR_PLANNED_FOREST_R);
      const rawAttestation = m.get(CBOR_ATTESTATION);
      if (rawAttestation instanceof Uint8Array && rawAttestation.length > 0) {
        attestation = rawAttestation;
      }
    }
  } catch {
    return attachCors(
      ClientErrors.badRequest("Invalid CBOR body"),
      corsHeaders,
    );
  }

  if (!label || !chainId || !univocityAddr || !contactEmail) {
    return attachCors(
      ClientErrors.badRequest(
        "label, chainId, univocityAddr, contactEmail required",
      ),
      corsHeaders,
    );
  }

  const fieldErr = checkOnboardFieldLengths({
    label,
    contactEmail,
    mandateOrigin,
  });
  if (fieldErr) return attachCors(fieldErr, corsHeaders);

  const gate = await verifyUnivocityDeployment(env, chainId, univocityAddr);
  if (!gate.ok) {
    return attachCors(
      problemResponse(
        gate.status,
        gate.status === 422
          ? "Unprocessable Entity"
          : gate.status === 503
            ? "Service Unavailable"
            : "Bad Request",
        "about:blank",
        { detail: gate.detail },
      ),
      corsHeaders,
    );
  }

  // Bootstrap-key registrant attestation (slice 06, ADR-0059 D8). The gate
  // probe supplies the chain-declared (alg, key) trust anchor. An attestation
  // is VERIFIED whenever present — a request carrying a bad one is rejected
  // even while the flag is off, so a broken producer is caught before the
  // flag arms; the flag only controls whether absence is fatal. Break-glass
  // ops mint is the documented waiver (visible via admittedBy).
  const requireAttestation =
    env.ONBOARD_REQUIRE_KEY_ATTESTATION?.trim() === "true";
  if (!attestation && requireAttestation) {
    return attachCors(
      ClientErrors.badRequest(
        "onboard request requires a bootstrap-key attestation (CBOR key 7)",
      ),
      corsHeaders,
    );
  }
  if (attestation) {
    const requestOrigin = new URL(request.url).origin;
    const audOverride = env.ONBOARD_ATTESTATION_AUD?.trim();
    const maxWindowRaw = Number.parseInt(
      env.ONBOARD_ATTESTATION_MAX_WINDOW_SEC?.trim() ?? "",
      10,
    );
    const verdict = await verifyOnboardAttestation(
      attestation,
      {
        alg: gate.bootstrapAlg,
        key: gate.bootstrapKey,
        chainId: chainId.trim(),
        univocityAddr: gate.univocityAddr,
        acceptedAud: audOverride
          ? [audOverride, requestOrigin]
          : [requestOrigin],
        nowSec: Math.floor(Date.now() / 1000),
        maxWindowSec:
          Number.isFinite(maxWindowRaw) && maxWindowRaw > 0
            ? maxWindowRaw
            : DEFAULT_ATTESTATION_MAX_WINDOW_SEC,
      },
      // Safe 1x1 (Mode D, plan-2607-45): the bootstrap key may be a contract
      // account — the ERC-1271 capability lets it validate; EOA roots are
      // unaffected.
      attestationVerifyCapabilities(env, chainId.trim(), gate.bootstrapAlg),
    );
    if (!verdict.ok) {
      // RPC outage is an availability outcome, not a verdict — 503 like the
      // deployment gate's RPC-failure path (plan-2607-09 R1).
      return attachCors(
        verdict.unavailable
          ? problemResponse(503, "Service Unavailable", "about:blank", {
              detail: `attestation verification unavailable: ${verdict.detail}`,
            })
          : problemResponse(403, "Forbidden", "about:blank", {
              detail: `attestation rejected: ${verdict.detail}`,
            }),
        corsHeaders,
      );
    }
  }

  const pendingCount = await countNonTerminalRequestsForBinding(
    env,
    chainId.trim(),
    gate.univocityAddr,
  );
  if (pendingCount >= maxPendingPerBinding(env)) {
    return attachCors(
      ClientErrors.conflict(
        "Too many pending onboard requests for this Univocity binding",
      ),
      corsHeaders,
    );
  }

  const { record, redeemCode } = await createOnboardRequest(env, {
    label,
    chainBinding: {
      chainId: chainId.trim(),
      univocityAddr: gate.univocityAddr,
    },
    contactEmail,
    mandateOrigin,
    plannedForestR,
    ttlSec: defaultRequestTtlSec(env),
    attested: attestation !== undefined,
  });

  // Retention (D8): one small COSE object per instance, standing dispute
  // evidence, verifiable against chain state forever. Deliberately outside
  // the TTL'd request record; last attestation per instance wins. Written
  // only once the request record exists — a quota- or cap-rejected create
  // must not overwrite the standing blob (plan-2607-46 slice 01 hygiene).
  if (attestation) {
    const instanceId = tryUnivocityInstanceIdFromChainBinding({
      chainId: chainId.trim(),
      univocityAddr: gate.univocityAddr,
    });
    if (instanceId) {
      await env.R2_GRANTS.put(
        `payments/attestations/${instanceId}.cose`,
        attestation,
        { httpMetadata: { contentType: "application/cose" } },
      );
    }
  }

  scheduleOnboardWebhook(ctx, env, "onboard.request.created", {
    requestId: record.requestId,
    label: record.label,
    chainBinding: record.chainBinding,
    contactEmail: record.contactEmail,
    mandateOrigin: record.mandateOrigin,
  });

  let finalRecord = record;
  if (shouldAutoApproveRequest(env, record)) {
    const approved = await approveRequestRecord(env, record.requestId);
    if (approved instanceof Response) {
      return attachCors(approved, corsHeaders);
    }
    // Recorded so redeem can mint admittedBy "auto" rather than "ops" (F6).
    finalRecord = { ...approved, autoApproved: true };
    await writeOnboardRequest(env, finalRecord);
    scheduleOnboardWebhook(ctx, env, "onboard.request.approved", {
      requestId: finalRecord.requestId,
    });
  }

  return attachCors(
    cborResponse(
      {
        requestId: finalRecord.requestId,
        status: effectiveStatus(finalRecord),
        expiresAt: finalRecord.expiresAt,
        redeemCode,
      },
      201,
      NO_STORE_HEADERS,
    ),
    corsHeaders,
  );
}

function readString(m: Map<number, unknown>, key: number): string | undefined {
  const v = m.get(key);
  if (typeof v !== "string") return undefined;
  const s = v.trim();
  return s || undefined;
}

/**
 * Re-issue the onboard token for an already-redeemed request (plan-2607-46
 * slice 02, decisions Q2): fresh token with the same binding/admission, the
 * previous ref revoked — at most one active token per request, and a lost
 * (possibly stolen) token dies on recovery. Valid until the request expires;
 * `effectiveStatus` never expires a `redeemed` record, so the window is
 * checked here explicitly.
 *
 * Fenced against concurrency and crashes (plan-2607-10 R1): the ref-write
 * is an etag CAS — a losing writer revokes its own mint and retries — and
 * the winner then revokes EVERY other active token for the request, which
 * also self-heals orphans left by earlier crashed reissues. Order matters:
 * mint → CAS ref → sweep, so the record never points at a revoked token.
 */
async function reissueRedeemedToken(
  env: OnboardingHandlerEnv,
  record: OnboardRequestRecord,
  ctx: ExecutionContext,
): Promise<Response> {
  const now = Math.floor(Date.now() / 1000);

  for (let attempt = 0; attempt < 3; attempt++) {
    const current = await readOnboardRequestWithEtag(env, record.requestId);
    if (!current) {
      return problemResponse(404, "Not Found", "about:blank", {
        detail: "Request not found",
      });
    }
    if (current.record.expiresAt <= now) {
      return problemResponse(410, "Gone", "about:blank", {
        detail: "Request expired; the redeem code no longer re-issues a token",
      });
    }

    // Admission carries over from the original token when it is still
    // readable; the crash-before-ref-write corner has no old token to copy
    // from, so fall back to what the request itself records.
    const previousRef = current.record.onboardTokenRef;
    const previous = previousRef
      ? await readOnboardTokenRecord(env, previousRef)
      : null;
    const admittedBy =
      previous?.admittedBy ?? (current.record.autoApproved ? "auto" : "ops");

    const minted = await mintOnboardToken(env, {
      label: current.record.label,
      requestId: current.record.requestId,
      chainBinding: current.record.chainBinding,
      expiry: now + defaultTokenTtlSec(env),
      admittedBy,
    });

    const withRef: OnboardRequestRecord = {
      ...current.record,
      onboardTokenRef: minted.record.hash,
    };
    const won = await writeOnboardRequestCas(env, withRef, current.etag);
    if (!won) {
      // Lost a concurrent reissue: this mint must not survive as an orphan.
      await revokeOnboardToken(env, minted.record.hash);
      continue;
    }

    await revokeOtherActiveTokensForRequest(
      env,
      withRef.requestId,
      minted.record.hash,
    );

    // Re-emitted per reissue — consumers must tolerate repeat delivery for
    // one requestId (the ref identifies the current token).
    scheduleOnboardWebhook(ctx, env, "onboard.request.redeemed", {
      requestId: withRef.requestId,
      onboardTokenRef: withRef.onboardTokenRef,
    });

    return cborResponse(
      {
        token: minted.token,
        ref: minted.record.hash,
        label: withRef.label,
      },
      200,
      NO_STORE_HEADERS,
    );
  }

  return ClientErrors.conflict(
    "Concurrent re-redeem contention; retry the redeem request",
  );
}

async function handleRedeem(
  request: Request,
  requestId: string,
  env: OnboardingHandlerEnv,
  corsHeaders: Record<string, string>,
  ctx: ExecutionContext,
): Promise<Response> {
  const ctErr = requireContentTypeCbor(request);
  if (ctErr) return attachCors(ctErr, corsHeaders);

  // R7: the paid path calls the facilitator per attempt — bound the rate.
  const rlErr = await checkOnboardRedeemRateLimit(request, env);
  if (rlErr) return attachCors(rlErr, corsHeaders);

  let redeemCode: string | undefined;
  try {
    const raw = await parseCborBody(request);
    const m = decodeBodyAsIntKeyMap(raw);
    if (m) redeemCode = readString(m, CBOR_REDEEM_CODE);
  } catch {
    return attachCors(
      ClientErrors.badRequest("Invalid CBOR body"),
      corsHeaders,
    );
  }

  if (!redeemCode) {
    return attachCors(
      ClientErrors.badRequest("redeemCode required"),
      corsHeaders,
    );
  }

  const record = await readOnboardRequest(env, requestId);
  if (!record) {
    return attachCors(
      ClientErrors.notFound("Not Found", "Request not found"),
      corsHeaders,
    );
  }

  // Authenticate the requester (holds the one-time redeem code) before the
  // approve/pay branch, so a random payer cannot redeem someone else's request.
  const codeOk = await verifyRedeemCode(record, redeemCode);
  if (!codeOk) {
    return attachCors(
      ClientErrors.unauthorized("Invalid redeem code"),
      corsHeaders,
    );
  }

  // Approval gate. An ops-`approved` request redeems as before with no payment.
  // A `pending` (unapproved) request may be approved by paying — payment is an
  // alternative approver (FOR-433/FOR-434). Other states error as before.
  const status = effectiveStatus(record);
  let settlementJob: SettlementJob | undefined;
  if (status === "pending") {
    // Admission policy (ADR-0059 decision 3): under `vetted`, payment is never
    // solicited — a pending request waits for ops approval and redeem says so.
    const admission = onboardAdmission(env);
    if (admission instanceof Response)
      return attachCors(admission, corsHeaders);
    if (admission === "vetted") {
      return attachCors(
        ClientErrors.conflict(
          "Request awaiting operator approval; this deployment does not accept payment as approval.",
        ),
        corsHeaders,
      );
    }
    const resourceUrl = request.url;
    const outcome = await verifyOnboardPayment(request, env, resourceUrl);
    if (outcome.status === "challenge" || outcome.status === "invalid") {
      // No payment presented, or the facilitator rejected it: (re)issue the 402
      // challenge. A failed verify mints nothing — this returns before any mint.
      return attachCors(
        paymentRequiredResponse(env, resourceUrl, outcome.reason),
        corsHeaders,
      );
    }
    // FOR-441: claim the payment authorization for single use BEFORE any state
    // transition or mint. Verify is stateless — the same unspent authorization
    // verifies for every concurrent request until settlement lands — so without
    // this claim one payment mints one token per onboard request.
    const claimed = await claimPaymentAuthorization(
      env,
      outcome.payment,
      requestId,
    );
    if (!claimed) {
      return attachCors(
        paymentRequiredResponse(
          env,
          resourceUrl,
          "payment authorization already used; sign a new payment",
        ),
        corsHeaders,
      );
    }

    // Payment-auth claim BEFORE the reservation is load-bearing: verify is
    // stateless, so reserving first would let a replayed, never-settling
    // authorization buy reservations. On a reserve conflict the claimed auth
    // moves no money (settlement is only enqueued after mint) — the caller
    // signs afresh and lost nothing.
    const reserveErr = await reserveForRequest(env, record);
    if (reserveErr) return attachCors(reserveErr, corsHeaders);

    // Valid, unused payment approves the request. CAS makes approve
    // exactly-once; a concurrent ops-approve/redeem falls through to the gate.
    const approve = await transitionPendingToApprovedCas(env, requestId);
    if (!approve.ok) {
      const reread = await readOnboardRequest(env, requestId);
      if (reread) {
        const g = redeemOrStatusHttpError(reread);
        if (g.kind === "response") return attachCors(g.response, corsHeaders);
      }
      return attachCors(
        ClientErrors.conflict("Request already redeemed"),
        corsHeaders,
      );
    }
    settlementJob = buildOnboardSettlementJob({
      payment: outcome.payment,
      authId: outcome.authId,
      requestId,
      now: Date.now(),
    });
  } else if (status === "redeemed") {
    // Idempotent re-redeem (plan-2607-46 slice 02): the redeemCode already
    // authenticated the holder, so a client that lost the token after the
    // approved→redeemed commit recovers here with a fresh token. Never a new
    // payment — admission was recorded at first redeem and any x402
    // authorization was claim-burned before the transition, so a 402 here
    // would double-charge.
    return attachCors(
      await reissueRedeemedToken(env, record, ctx),
      corsHeaders,
    );
  } else if (status !== "approved") {
    // expired / rejected — existing state errors.
    const gateErr = redeemOrStatusHttpError(record);
    if (gateErr.kind === "response") {
      return attachCors(gateErr.response, corsHeaders);
    }
    return attachCors(
      ClientErrors.conflict("Request not approved"),
      corsHeaders,
    );
  }

  // Ops-approved (and vetted) entries reserve here; the paid branch above
  // already holds the reservation and this repeat is idempotent per holder.
  const approvedReserveErr = await reserveForRequest(env, record);
  if (approvedReserveErr) return attachCors(approvedReserveErr, corsHeaders);

  const transition = await transitionApprovedToRedeemedCas(env, requestId);
  if (!transition.ok) {
    if (transition.reason === "not_found") {
      return attachCors(
        ClientErrors.notFound("Not Found", "Request not found"),
        corsHeaders,
      );
    }
    const reread = await readOnboardRequest(env, requestId);
    if (reread) {
      const retryGate = redeemOrStatusHttpError(reread);
      if (retryGate.kind === "response") {
        return attachCors(retryGate.response, corsHeaders);
      }
    }
    return attachCors(
      ClientErrors.conflict("Request already redeemed"),
      corsHeaders,
    );
  }

  const now = Math.floor(Date.now() / 1000);
  const minted = await mintOnboardToken(env, {
    label: transition.record.label,
    requestId,
    chainBinding: transition.record.chainBinding,
    expiry: now + defaultTokenTtlSec(env),
    // A settlement job exists only when payment approved the request on this
    // call; otherwise distinguish the dev auto-approve path from a real
    // operator action so "ops" always means a person acted (F6).
    admittedBy: settlementJob
      ? "payment"
      : transition.record.autoApproved
        ? "auto"
        : "ops",
  });

  const withRef: OnboardRequestRecord = {
    ...transition.record,
    onboardTokenRef: minted.record.hash,
  };
  await writeOnboardRequest(env, withRef);

  // Reinstated producer (FOR-434): for the paid path, enqueue settlement so the
  // worker collects the funds asynchronously. Mint-on-verify — the token is
  // already issued, so a failed enqueue is logged for reconciliation, not fatal.
  if (settlementJob) {
    settlementJob.onboardTokenRef = minted.record.hash;
    await enqueueOnboardSettlement(env, settlementJob);
  }

  scheduleOnboardWebhook(ctx, env, "onboard.request.redeemed", {
    requestId: withRef.requestId,
    onboardTokenRef: withRef.onboardTokenRef,
  });

  return attachCors(
    cborResponse(
      {
        token: minted.token,
        ref: minted.record.hash,
        label: withRef.label,
      },
      200,
      NO_STORE_HEADERS,
    ),
    corsHeaders,
  );
}

async function handleOpsApprove(
  requestId: string,
  env: OnboardingHandlerEnv,
  corsHeaders: Record<string, string>,
  ctx: ExecutionContext,
  responseFormat: "json" | "cbor" = "cbor",
): Promise<Response> {
  const approved = await approveRequestRecord(env, requestId);
  if (approved instanceof Response) {
    return attachFormat(approved, corsHeaders, responseFormat === "json");
  }

  scheduleOnboardWebhook(ctx, env, "onboard.request.approved", {
    requestId: approved.requestId,
  });

  const payload = {
    requestId: approved.requestId,
    status: approved.status,
  };

  return attachCors(
    responseFormat === "json"
      ? adminJsonResponse(payload, 200)
      : cborResponse(payload, 200),
    corsHeaders,
  );
}

async function handleOpsReject(
  request: Request,
  requestId: string,
  env: OnboardingHandlerEnv,
  corsHeaders: Record<string, string>,
  ctx: ExecutionContext,
  responseFormat: "json" | "cbor" = "cbor",
): Promise<Response> {
  let rejectReason: string | undefined;
  const ct = request.headers.get("Content-Type") ?? "";
  if (ct.includes("application/json")) {
    try {
      const body = (await request.json()) as { rejectReason?: unknown };
      if (typeof body.rejectReason === "string") {
        const trimmed = body.rejectReason.trim();
        if (trimmed) rejectReason = trimmed;
      }
    } catch {
      /* optional body */
    }
  } else if (ct.includes("application/cbor")) {
    try {
      const raw = await parseCborBody(request);
      const m = decodeBodyAsIntKeyMap(raw);
      if (m) rejectReason = readString(m, CBOR_REJECT_REASON);
    } catch {
      /* optional body */
    }
  }

  const reasonErr = checkOnboardRejectReasonLength(rejectReason);
  if (reasonErr) {
    return attachFormat(reasonErr, corsHeaders, responseFormat === "json");
  }

  const transition = await transitionPendingToRejectedCas(
    env,
    requestId,
    rejectReason,
  );
  if (!transition.ok) {
    if (transition.reason === "not_found") {
      return attachFormat(
        ClientErrors.notFound("Not Found", "Request not found"),
        corsHeaders,
        responseFormat === "json",
      );
    }
    return attachFormat(
      await pendingTransitionConflict(env, requestId),
      corsHeaders,
      responseFormat === "json",
    );
  }

  scheduleOnboardWebhook(ctx, env, "onboard.request.rejected", {
    requestId,
    rejectReason,
  });

  const payload = { requestId, status: "rejected" as const };
  return attachCors(
    responseFormat === "json"
      ? adminJsonResponse(payload, 200)
      : cborResponse(payload, 200),
    corsHeaders,
  );
}

async function attachFormat(
  res: Response,
  corsHeaders: Record<string, string>,
  useJson: boolean,
): Promise<Response> {
  const out = await asAdminJsonResponse(res, useJson);
  return attachCors(out, corsHeaders);
}

async function opsAdminJsonAuth(
  request: Request,
  env: OnboardingHandlerEnv,
): Promise<Response | null> {
  const authErr = opsAuth(request, env);
  if (!authErr) return null;
  return problemResponseToAdminJson(authErr);
}

function opsAuth(request: Request, env: OnboardingHandlerEnv): Response | null {
  const token = env.CANOPY_OPS_ADMIN_TOKEN?.trim() ?? "";
  return opsAdminBearerOrUnauthorized(request, token);
}

export async function handleOnboardingRequest(
  request: Request,
  pathname: string,
  env: OnboardingHandlerEnv,
  corsHeaders: Record<string, string>,
  ctx: ExecutionContext,
): Promise<Response | null> {
  if (
    pathname !== "/api/onboarding" &&
    !pathname.startsWith("/api/onboarding/")
  ) {
    return null;
  }

  const adminJson =
    pathname === "/api/onboarding/admin/requests" && request.method === "GET";
  const adminTokens =
    pathname === "/api/onboarding/admin/tokens" && request.method === "GET";

  if (adminJson || adminTokens) {
    const authErr = await opsAdminJsonAuth(request, env);
    if (authErr) return attachCors(authErr, corsHeaders);
    if (adminJson) {
      const { limit, cursor } = parseListPagination(request.url);
      const listed = await listOnboardRequests(env, { limit, cursor });
      return attachCors(
        adminJsonResponse({
          requests: listed.requests.map((r) => ({
            ...publicRequestView(r),
            contactEmail: r.contactEmail,
            rejectReason: r.rejectReason,
          })),
          cursor: listed.cursor,
        }),
        corsHeaders,
      );
    }
    const tokens = await listOnboardTokens(env);
    return attachCors(adminJsonResponse({ tokens }), corsHeaders);
  }

  const adminApprove =
    /^\/api\/onboarding\/admin\/requests\/([^/]+)\/approve$/.exec(pathname);
  if (adminApprove && request.method === "POST") {
    const authErr = await opsAdminJsonAuth(request, env);
    if (authErr) return attachCors(authErr, corsHeaders);
    return handleOpsApprove(
      decodeURIComponent(adminApprove[1]!),
      env,
      corsHeaders,
      ctx,
      "json",
    );
  }

  const adminReject =
    /^\/api\/onboarding\/admin\/requests\/([^/]+)\/reject$/.exec(pathname);
  if (adminReject && request.method === "POST") {
    const authErr = await opsAdminJsonAuth(request, env);
    if (authErr) return attachCors(authErr, corsHeaders);
    return handleOpsReject(
      request,
      decodeURIComponent(adminReject[1]!),
      env,
      corsHeaders,
      ctx,
      "json",
    );
  }

  if (pathname === "/api/onboarding/requests") {
    if (request.method === "POST") {
      return handleCreateRequest(request, env, corsHeaders, ctx);
    }
    if (request.method === "GET") {
      const authErr = opsAuth(request, env);
      if (authErr) return attachCors(authErr, corsHeaders);
      const { limit, cursor } = parseListPagination(request.url);
      const listed = await listOnboardRequests(env, { limit, cursor });
      return attachCors(
        cborResponse(
          {
            requests: listed.requests.map(publicRequestView),
            cursor: listed.cursor,
          },
          200,
        ),
        corsHeaders,
      );
    }
  }

  const itemMatch = /^\/api\/onboarding\/requests\/([^/]+)$/.exec(pathname);
  if (itemMatch && request.method === "GET") {
    const record = await readOnboardRequest(
      env,
      decodeURIComponent(itemMatch[1]!),
    );
    if (!record) {
      return attachCors(
        ClientErrors.notFound("Not Found", "Request not found"),
        corsHeaders,
      );
    }
    return attachCors(
      cborResponse(publicRequestView(record), 200, NO_STORE_HEADERS),
      corsHeaders,
    );
  }

  const approveMatch = /^\/api\/onboarding\/requests\/([^/]+)\/approve$/.exec(
    pathname,
  );
  if (approveMatch && request.method === "POST") {
    const authErr = opsAuth(request, env);
    if (authErr) return attachCors(authErr, corsHeaders);
    return handleOpsApprove(
      decodeURIComponent(approveMatch[1]!),
      env,
      corsHeaders,
      ctx,
    );
  }

  const rejectMatch = /^\/api\/onboarding\/requests\/([^/]+)\/reject$/.exec(
    pathname,
  );
  if (rejectMatch && request.method === "POST") {
    const authErr = opsAuth(request, env);
    if (authErr) return attachCors(authErr, corsHeaders);
    return handleOpsReject(
      request,
      decodeURIComponent(rejectMatch[1]!),
      env,
      corsHeaders,
      ctx,
    );
  }

  const redeemMatch = /^\/api\/onboarding\/requests\/([^/]+)\/redeem$/.exec(
    pathname,
  );
  if (redeemMatch && request.method === "POST") {
    return handleRedeem(
      request,
      decodeURIComponent(redeemMatch[1]!),
      env,
      corsHeaders,
      ctx,
    );
  }

  return attachCors(
    ClientErrors.notFound("Not Found", `Unknown onboarding route ${pathname}`),
    corsHeaders,
  );
}
