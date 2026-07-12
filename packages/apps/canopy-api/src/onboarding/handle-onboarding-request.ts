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
  type OnboardTokenStoreEnv,
} from "../payments/onboard-token-store.js";
import { shouldAutoApproveRequest } from "./onboard-auto-approve.js";
import {
  checkOnboardCreateBodySize,
  checkOnboardCreateRateLimit,
  checkOnboardFieldLengths,
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
  transitionApprovedToRedeemedCas,
  transitionPendingToApprovedCas,
  transitionPendingToRejectedCas,
  verifyRedeemCode,
  writeOnboardRequest,
  type OnboardRequestStoreEnv,
} from "./onboard-request-store.js";
import { verifyUnivocityDeployment } from "./univocity-deployment-gate.js";
import type { UnivocityGateEnv } from "./univocity-deployment-gate.js";

const CBOR_LABEL = 1;
const CBOR_CHAIN_ID = 2;
const CBOR_UNIVOCITY_ADDR = 3;
const CBOR_CONTACT_EMAIL = 4;
const CBOR_MANDATE_ORIGIN = 5;
const CBOR_PLANNED_FOREST_R = 6;
const CBOR_REDEEM_CODE = 1;
const CBOR_REJECT_REASON = 1;

const NO_STORE_HEADERS = { "cache-control": "no-store" };

export interface OnboardingHandlerEnv
  extends OnboardRequestStoreEnv,
    OnboardTokenStoreEnv,
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
  });

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
    finalRecord = approved;
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

async function handleRedeem(
  request: Request,
  requestId: string,
  env: OnboardingHandlerEnv,
  corsHeaders: Record<string, string>,
  ctx: ExecutionContext,
): Promise<Response> {
  const ctErr = requireContentTypeCbor(request);
  if (ctErr) return attachCors(ctErr, corsHeaders);

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

  const gateErr = redeemOrStatusHttpError(record);
  if (gateErr.kind === "response") {
    return attachCors(gateErr.response, corsHeaders);
  }

  const codeOk = await verifyRedeemCode(record, redeemCode);
  if (!codeOk) {
    return attachCors(
      ClientErrors.unauthorized("Invalid redeem code"),
      corsHeaders,
    );
  }

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
  });

  const withRef: OnboardRequestRecord = {
    ...transition.record,
    onboardTokenRef: minted.record.hash,
  };
  await writeOnboardRequest(env, withRef);

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
