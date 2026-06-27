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

export interface PaymentsHandlerEnv
  extends OnboardTokenStoreEnv,
    RegistrationStoreEnv,
    CoordinatorEnabledClientEnv {
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
      try {
        const raw = await parseCborBody(request);
        const m = decodeBodyAsIntKeyMap(raw);
        if (m) {
          label = readOptionalStringField(m, 1);
          expiry = readOptionalExpiry(m);
        }
      } catch {
        return attachCors(
          ClientErrors.badRequest("Invalid CBOR body"),
          corsHeaders,
        );
      }

      const minted = await mintOnboardToken(env, { label, expiry });
      return attachCors(
        cborResponse(
          {
            token: minted.token,
            ref: minted.record.hash,
            label: minted.record.label,
            createdAt: minted.record.createdAt,
            expiry: minted.record.expiry,
            status: minted.record.status,
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
