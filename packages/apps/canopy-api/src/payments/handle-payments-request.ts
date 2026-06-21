/**
 * `POST/GET/DELETE /api/payments/onboard-tokens` — ops mint/list/revoke.
 */

import { parseCborBody } from "../cbor-api/cbor-request.js";
import {
  cborResponse,
  problemResponse,
  requireContentTypeCbor,
} from "../cbor-api/cbor-response.js";
import { ClientErrors } from "../cbor-api/problem-details.js";
import { decodeBodyAsIntKeyMap } from "../cbor-api/cbor-map-utils.js";
import { opsAdminBearerOrUnauthorized } from "./bearer-auth.js";
import {
  listOnboardTokens,
  mintOnboardToken,
  revokeOnboardToken,
  type OnboardTokenStoreEnv,
} from "./onboard-token-store.js";

export interface PaymentsHandlerEnv extends OnboardTokenStoreEnv {
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

  const token = env.CANOPY_OPS_ADMIN_TOKEN?.trim() ?? "";
  const authErr = opsAdminBearerOrUnauthorized(request, token);
  if (authErr) return attachCors(authErr, corsHeaders);

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
        return attachCors(ClientErrors.badRequest("Invalid CBOR body"), corsHeaders);
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
    return attachCors(cborResponse({ ref: revoked.hash, status: revoked.status }, 200), corsHeaders);
  }

  return attachCors(
    ClientErrors.notFound("Not Found", `Unknown payments route ${pathname}`),
    corsHeaders,
  );
}
