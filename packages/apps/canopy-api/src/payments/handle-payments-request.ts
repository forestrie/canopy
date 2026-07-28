/**
 * `POST/GET/DELETE /api/payments/onboard-tokens` — ops mint/list/revoke.
 * `PUT/GET /api/payments/registrations/{R}/enabled` — kill-switch controller.
 */

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
import { ClientErrors } from "../cbor-api/problem-details.js";
import { decodeBodyAsIntKeyMap } from "../cbor-api/cbor-map-utils.js";
import {
  logIdSegmentToCanonicalUuid,
  parseLogIdSegment,
} from "../grant/log-id-wire.js";
import { opsAdminBearerOrUnauthorized } from "./bearer-auth.js";
import {
  getCoordinatorEnabled,
  putCoordinatorEnabled,
  type CoordinatorEnabledClientEnv,
} from "./coordinator-enabled-client.js";
import {
  listOnboardTokens,
  mintOnboardToken,
  revokeOnboardToken,
  type OnboardTokenStoreEnv,
} from "./onboard-token-store.js";
import {
  readRegistration,
  type RegistrationStoreEnv,
} from "./registration-store.js";
import {
  isUnivocityInstanceId,
  tryUnivocityInstanceIdFromChainBinding,
} from "@canopy/univocity-instance-id";
import {
  isValidRegistrationBlock,
  readUnivocityInstanceReservation,
  releaseUnivocityInstanceReservation,
  reserveUnivocityInstance,
  setUnivocityInstanceRegistrationBlock,
  tokenHolder,
} from "./instance-registry.js";

import {
  handleCreditsPurchase,
  type CreditsPurchaseEnv,
} from "./credits-purchase.js";
import { handleAccountRead, type AccountReadEnv } from "./account-read.js";

export interface PaymentsHandlerEnv
  extends OnboardTokenStoreEnv,
    RegistrationStoreEnv,
    CoordinatorEnabledClientEnv,
    CreditsPurchaseEnv,
    AccountReadEnv {
  CANOPY_OPS_ADMIN_TOKEN?: string;
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

function readOptionalStringField(
  m: Map<number, unknown>,
  key: number,
): string | undefined {
  const v = m.get(key);
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string") return undefined;
  const s = v.trim();
  return s || undefined;
}

function readOptionalExpiry(m: Map<number, unknown>): number | undefined {
  const v = m.get(2);
  if (v === undefined || v === null) return undefined;
  if (typeof v === "number" && Number.isInteger(v)) return v;
  if (typeof v === "bigint") {
    const n = Number(v);
    return Number.isSafeInteger(n) ? n : undefined;
  }
  return undefined;
}

function readEnabledField(m: Map<number, unknown>): boolean | undefined {
  const v = m.get(1);
  if (typeof v === "boolean") return v;
  return undefined;
}

function parseRegistrationLogId(segment: string): Uint8Array | Response {
  try {
    return parseLogIdSegment(segment);
  } catch (error) {
    return ClientErrors.badRequest(
      error instanceof Error ? error.message : "Invalid log id",
    );
  }
}

async function attachFormat(
  res: Response,
  corsHeaders: Record<string, string>,
  useJson: boolean,
): Promise<Response> {
  const out = await asAdminJsonResponse(res, useJson);
  return attachCors(out, corsHeaders);
}

async function handleRegistrationEnabled(
  request: Request,
  logIdSegment: string,
  env: PaymentsHandlerEnv,
  corsHeaders: Record<string, string>,
  responseFormat: "json" | "cbor" = "cbor",
): Promise<Response> {
  const parsed = parseRegistrationLogId(logIdSegment);
  if (parsed instanceof Response) {
    return attachFormat(parsed, corsHeaders, responseFormat === "json");
  }

  const registration = await readRegistration(env, parsed);
  if (!registration) {
    return attachFormat(
      ClientErrors.notFound("Not Found", "Registration not found for log"),
      corsHeaders,
      responseFormat === "json",
    );
  }

  const logUuid = logIdSegmentToCanonicalUuid(logIdSegment);

  if (request.method === "GET") {
    const result = await getCoordinatorEnabled(env, logUuid);
    if (!result.ok) {
      return attachFormat(
        problemResponse(result.status, "Service Unavailable", "about:blank", {
          detail: result.detail,
        }),
        corsHeaders,
        responseFormat === "json",
      );
    }
    return attachCors(
      responseFormat === "json"
        ? adminJsonResponse({ R: logUuid, enabled: result.enabled }, 200)
        : cborResponse({ R: logUuid, enabled: result.enabled }, 200),
      corsHeaders,
    );
  }

  if (request.method === "PUT") {
    let enabled: boolean | undefined;
    const ct = request.headers.get("Content-Type") ?? "";
    if (responseFormat === "json" || ct.includes("application/json")) {
      try {
        const body = (await request.json()) as { enabled?: unknown };
        if (typeof body.enabled === "boolean") enabled = body.enabled;
      } catch {
        return attachFormat(
          ClientErrors.badRequest("Invalid JSON body"),
          corsHeaders,
          responseFormat === "json",
        );
      }
    } else {
      const ctErr = requireContentTypeCbor(request);
      if (ctErr) return attachCors(ctErr, corsHeaders);

      try {
        const raw = await parseCborBody(request);
        const m = decodeBodyAsIntKeyMap(raw);
        if (m) {
          enabled = readEnabledField(m);
        }
      } catch {
        return attachCors(
          ClientErrors.badRequest("Invalid CBOR body"),
          corsHeaders,
        );
      }
    }

    if (enabled === undefined) {
      return attachFormat(
        ClientErrors.badRequest("enabled must be a boolean"),
        corsHeaders,
        responseFormat === "json",
      );
    }

    const result = await putCoordinatorEnabled(env, logUuid, enabled);
    if (!result.ok) {
      return attachFormat(
        problemResponse(result.status, "Service Unavailable", "about:blank", {
          detail: result.detail,
        }),
        corsHeaders,
        responseFormat === "json",
      );
    }
    return attachCors(
      responseFormat === "json"
        ? adminJsonResponse({ R: logUuid, enabled: result.enabled }, 200)
        : cborResponse({ R: logUuid, enabled: result.enabled }, 200),
      corsHeaders,
    );
  }

  return attachCors(
    problemResponse(405, "Method Not Allowed", "about:blank", {
      detail: `Method ${request.method} not allowed`,
    }),
    corsHeaders,
  );
}

/**
 * @returns a `Response` for `/api/payments/**`, else `null`.
 */
export async function handlePaymentsRequest(
  request: Request,
  pathname: string,
  env: PaymentsHandlerEnv,
  corsHeaders: Record<string, string>,
): Promise<Response | null> {
  if (pathname !== "/api/payments" && !pathname.startsWith("/api/payments/")) {
    return null;
  }

  // Payer-facing purchase — the ONLY route under /api/payments/** outside the
  // ops bearer gate. The x402 payment is the authorization (as on onboard
  // redeem); everything else below remains ops-token-gated.
  const creditsMatch = /^\/api\/payments\/credits\/([^/]+)$/.exec(pathname);
  if (creditsMatch) {
    return handleCreditsPurchase(
      request,
      decodeURIComponent(creditsMatch[1]!),
      env,
      corsHeaders,
    );
  }

  // Owner-facing fee-account read (FOR-497) — outside the ops bearer gate:
  // the bootstrap-key attestation in the Authorization header is the
  // authorization, verified against the chain-declared key inside the
  // handler. Everything else below remains ops-token-gated.
  const accountMatch = /^\/api\/payments\/accounts\/([^/]+)$/.exec(pathname);
  if (accountMatch) {
    return handleAccountRead(
      request,
      decodeURIComponent(accountMatch[1]!),
      env,
      corsHeaders,
    );
  }

  const isAdminJsonRoute = pathname.startsWith("/api/payments/admin/");
  const token = env.CANOPY_OPS_ADMIN_TOKEN?.trim() ?? "";
  const authErr = opsAdminBearerOrUnauthorized(request, token);
  if (authErr) {
    if (isAdminJsonRoute) {
      return attachCors(await problemResponseToAdminJson(authErr), corsHeaders);
    }
    return attachCors(authErr, corsHeaders);
  }

  if (pathname === "/api/payments/onboard-tokens") {
    if (request.method === "POST") {
      const ctErr = requireContentTypeCbor(request);
      if (ctErr) return attachCors(ctErr, corsHeaders);

      let label: string | undefined;
      let expiry: number | undefined;
      let chainId: string | undefined;
      let univocityAddr: string | undefined;
      try {
        const raw = await parseCborBody(request);
        const m = decodeBodyAsIntKeyMap(raw);
        if (m) {
          label = readOptionalStringField(m, 1);
          expiry = readOptionalExpiry(m);
          chainId = readOptionalStringField(m, 3);
          univocityAddr = readOptionalStringField(m, 4);
        }
      } catch {
        return attachCors(
          ClientErrors.badRequest("Invalid CBOR body"),
          corsHeaders,
        );
      }

      // Bindings are mandatory on every token (ADR-0059 decision 8): a
      // break-glass token is scoped to one instance like any other, and the
      // reservation it takes here is what a mistaken mint gets released from
      // (the chain-bindings DELETE below), not an open-ended claim on genesis.
      if (!chainId || !univocityAddr) {
        return attachCors(
          ClientErrors.badRequest(
            "chainId (3) and univocityAddr (4) are required",
          ),
          corsHeaders,
        );
      }
      const chainBinding = { chainId, univocityAddr };
      const univocityInstanceId =
        tryUnivocityInstanceIdFromChainBinding(chainBinding);
      if (!univocityInstanceId) {
        return attachCors(
          ClientErrors.badRequest(
            "chainId must be a bare decimal id and univocityAddr a 40-hex address",
          ),
          corsHeaders,
        );
      }

      const minted = await mintOnboardToken(env, {
        label,
        expiry,
        chainBinding,
        admittedBy: "ops",
      });

      const reserved = await reserveUnivocityInstance(
        env,
        univocityInstanceId,
        tokenHolder(minted.record.hash),
      );
      if (!reserved.ok) {
        await revokeOnboardToken(env, minted.record.hash);
        return attachCors(
          problemResponse(409, "Conflict", "about:blank", {
            detail: `Univocity instance ${univocityInstanceId} is already reserved or registered`,
          }),
          corsHeaders,
        );
      }

      return attachCors(
        cborResponse(
          {
            token: minted.token,
            ref: minted.record.hash,
            label: minted.record.label,
            createdAt: minted.record.createdAt,
            expiry: minted.record.expiry,
            status: minted.record.status,
            univocityInstanceId,
          },
          201,
        ),
        corsHeaders,
      );
    }

    if (request.method === "GET") {
      const tokens = await listOnboardTokens(env);
      return attachCors(cborResponse({ tokens }, 200), corsHeaders);
    }

    return attachCors(
      problemResponse(405, "Method Not Allowed", "about:blank", {
        detail: `Method ${request.method} not allowed`,
      }),
      corsHeaders,
    );
  }

  const revokeMatch = /^\/api\/payments\/onboard-tokens\/([0-9a-f]{64})$/i.exec(
    pathname,
  );
  if (revokeMatch) {
    if (request.method !== "DELETE") {
      return attachCors(
        problemResponse(405, "Method Not Allowed", "about:blank", {
          detail: `Method ${request.method} not allowed`,
        }),
        corsHeaders,
      );
    }
    const hash = revokeMatch[1]!.toLowerCase();
    const revoked = await revokeOnboardToken(env, hash);
    if (!revoked) {
      return attachCors(
        ClientErrors.notFound("Not Found", "Onboard token ref not found"),
        corsHeaders,
      );
    }
    return attachCors(
      cborResponse({ ref: revoked.hash, status: revoked.status }, 200),
      corsHeaders,
    );
  }

  // Ops inspection and release of an instance reservation (plan-2607-02 R4):
  // dangling `reserved` records, squats made before the registrant
  // attestation is enforced, abandoned roots. Release is the recovery route
  // the reservation model depends on — a paid reservation never expires.
  const bindingMatch = /^\/api\/payments\/chain-bindings\/([^/]+)$/.exec(
    pathname,
  );
  if (bindingMatch) {
    const id = decodeURIComponent(bindingMatch[1]!);
    if (!isUnivocityInstanceId(id)) {
      return attachCors(
        ClientErrors.badRequest(
          "path id must be a canonical univocity instance id",
        ),
        corsHeaders,
      );
    }
    if (request.method === "GET") {
      const record = await readUnivocityInstanceReservation(env, id);
      if (!record) {
        return attachCors(
          ClientErrors.notFound("Not Found", "No reservation for instance"),
          corsHeaders,
        );
      }
      return attachCors(
        cborResponse({ univocityInstanceId: id, ...record }, 200),
        corsHeaders,
      );
    }
    if (request.method === "DELETE") {
      const released = await releaseUnivocityInstanceReservation(env, id);
      if (!released) {
        return attachCors(
          ClientErrors.notFound("Not Found", "No reservation for instance"),
          corsHeaders,
        );
      }
      return attachCors(
        cborResponse(
          { univocityInstanceId: id, released: true, ...released },
          200,
        ),
        corsHeaders,
      );
    }
    // Repair the metering floor (plan-2607-04): the only mutation path for
    // `registrationBlock` besides genesis. Ops-authed by the bearer gate
    // above — never account-owner-facing (the floor is the operator's meter).
    if (request.method === "PATCH") {
      const ctErr = requireContentTypeCbor(request);
      if (ctErr) return attachCors(ctErr, corsHeaders);
      let registrationBlock: unknown;
      try {
        const m = decodeBodyAsIntKeyMap(await parseCborBody(request));
        registrationBlock = m?.get(1);
      } catch {
        return attachCors(
          ClientErrors.badRequest("Invalid CBOR body"),
          corsHeaders,
        );
      }
      if (!isValidRegistrationBlock(registrationBlock)) {
        return attachCors(
          ClientErrors.badRequest(
            "registrationBlock (1) must be a non-negative safe integer",
          ),
          corsHeaders,
        );
      }
      const set = await setUnivocityInstanceRegistrationBlock(
        env,
        id,
        registrationBlock,
      );
      if (!set.ok) {
        return attachCors(
          set.reason === "not_found"
            ? ClientErrors.notFound("Not Found", "No reservation for instance")
            : problemResponse(409, "Conflict", "about:blank", {
                detail:
                  "reservation update lost a race; retry the PATCH request",
              }),
          corsHeaders,
        );
      }
      return attachCors(
        cborResponse({ univocityInstanceId: id, ...set.record }, 200),
        corsHeaders,
      );
    }
    return attachCors(
      problemResponse(405, "Method Not Allowed", "about:blank", {
        detail: `Method ${request.method} not allowed`,
      }),
      corsHeaders,
    );
  }

  const adminEnabledMatch =
    /^\/api\/payments\/admin\/registrations\/([^/]+)\/enabled$/i.exec(pathname);
  if (adminEnabledMatch) {
    return handleRegistrationEnabled(
      request,
      decodeURIComponent(adminEnabledMatch[1]!),
      env,
      corsHeaders,
      "json",
    );
  }

  const enabledMatch =
    /^\/api\/payments\/registrations\/([^/]+)\/enabled$/i.exec(pathname);
  if (enabledMatch) {
    return handleRegistrationEnabled(
      request,
      decodeURIComponent(enabledMatch[1]!),
      env,
      corsHeaders,
    );
  }

  return attachCors(
    ClientErrors.notFound("Not Found", `Unknown payments route ${pathname}`),
    corsHeaders,
  );
}
