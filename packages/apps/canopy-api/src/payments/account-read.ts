/**
 * `GET /api/payments/accounts/{univocityInstanceId}` — the owner-facing
 * fee-account read (FOR-497): balance / arrears / frozen without the ops god
 * token, for the mandate console fee surface (FOR-485) and a `forestrie
 * balance` CLI verb.
 *
 * Auth is the ADR-0059 D8 bootstrap-key attestation carried in the
 * `Authorization` header (the one non-Content-Type header the CORS policy
 * admits): holder-of-bootstrap-key IS the account owner by construction, so
 * no session infrastructure is needed and the key may be in custody. The
 * envelope's signed content type is the read-domain one — an onboarding
 * attestation cannot be replayed here (see `account-read-attestation.ts`).
 *
 * The verify path's chain probe is bounded by the onboarding gate cache
 * (`verifyUnivocityDeployment` reads/writes the positive cache), so repeated
 * reads for one instance cost one RPC probe per cache TTL, not one per
 * request.
 */

import { cborResponse, problemResponse } from "../cbor-api/cbor-response.js";
import { ClientErrors } from "../cbor-api/problem-details.js";
import {
  adminJsonResponse,
  problemResponseToAdminJson,
} from "../cbor-api/admin-json-response.js";
import { verifyUnivocityDeployment } from "../onboarding/univocity-deployment-gate.js";
import type { UnivocityGateEnv } from "../onboarding/univocity-gate-env.js";
import {
  DEFAULT_ACCOUNT_READ_MAX_WINDOW_SEC,
  verifyAccountReadAttestation,
} from "./account-read-attestation.js";
import {
  getSettlementReceivables,
  type SettlementReceivablesClientEnv,
} from "./settlement-receivables-client.js";
import {
  chainBindingFromUnivocityInstanceId,
  isUnivocityInstanceId,
} from "@canopy/univocity-instance-id";

/** Authorization scheme carrying the base64url COSE_Sign1 read attestation. */
export const ACCOUNT_READ_AUTH_SCHEME = "Forestrie-Account-Read";

export interface AccountReadEnv
  extends UnivocityGateEnv,
    SettlementReceivablesClientEnv {
  /** Shared with onboarding: both attestations name the operator origin. */
  ONBOARD_ATTESTATION_AUD?: string;
  /** Ceiling on read-attestation exp-iat (seconds; default 300). */
  ACCOUNT_READ_ATTESTATION_MAX_WINDOW_SEC?: string;
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

function attestationFromAuthorization(request: Request): Uint8Array | null {
  const header = request.headers.get("Authorization")?.trim();
  if (!header) return null;
  const space = header.indexOf(" ");
  if (space < 0) return null;
  if (
    header.slice(0, space).toLowerCase() !==
    ACCOUNT_READ_AUTH_SCHEME.toLowerCase()
  ) {
    return null;
  }
  const b64url = header.slice(space + 1).trim();
  if (!b64url) return null;
  const b64 = b64url.replace(/-/g, "+").replace(/_/g, "/");
  try {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out.length > 0 ? out : null;
  } catch {
    return null;
  }
}

function maxWindowSec(env: AccountReadEnv): number {
  const raw = Number.parseInt(
    env.ACCOUNT_READ_ATTESTATION_MAX_WINDOW_SEC?.trim() ?? "",
    10,
  );
  return Number.isFinite(raw) && raw > 0
    ? raw
    : DEFAULT_ACCOUNT_READ_MAX_WINDOW_SEC;
}

/**
 * Handle the account read. The response is CBOR (house default) unless the
 * caller's `Accept` names `application/json` — the mandate console is a
 * browser client.
 */
export async function handleAccountRead(
  request: Request,
  univocityInstanceId: string,
  env: AccountReadEnv,
  corsHeaders: Record<string, string>,
): Promise<Response> {
  const useJson = (request.headers.get("Accept") ?? "").includes(
    "application/json",
  );
  const finish = async (res: Response): Promise<Response> =>
    attachCors(
      useJson ? await problemResponseToAdminJson(res) : res,
      corsHeaders,
    );

  if (request.method !== "GET") {
    return finish(
      problemResponse(405, "Method Not Allowed", "about:blank", {
        detail: `Method ${request.method} not allowed`,
      }),
    );
  }
  if (!isUnivocityInstanceId(univocityInstanceId)) {
    return finish(
      ClientErrors.badRequest(
        "path id must be a canonical univocity instance id",
      ),
    );
  }

  const attestation = attestationFromAuthorization(request);
  if (!attestation) {
    return finish(
      ClientErrors.unauthorized(
        `Authorization: ${ACCOUNT_READ_AUTH_SCHEME} <base64url COSE_Sign1> required`,
      ),
    );
  }

  const { chainId, univocityAddr } =
    chainBindingFromUnivocityInstanceId(univocityInstanceId);
  const gate = await verifyUnivocityDeployment(env, chainId, univocityAddr);
  if (!gate.ok) {
    return finish(
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
    );
  }

  const requestOrigin = new URL(request.url).origin;
  const audOverride = env.ONBOARD_ATTESTATION_AUD?.trim();
  const verdict = verifyAccountReadAttestation(attestation, {
    alg: gate.bootstrapAlg,
    key: gate.bootstrapKey,
    chainId,
    univocityAddr: gate.univocityAddr,
    acceptedAud: audOverride ? [audOverride, requestOrigin] : [requestOrigin],
    nowSec: Math.floor(Date.now() / 1000),
    maxWindowSec: maxWindowSec(env),
  });
  if (!verdict.ok) {
    return finish(
      problemResponse(403, "Forbidden", "about:blank", {
        detail: `attestation rejected: ${verdict.detail}`,
      }),
    );
  }

  const result = await getSettlementReceivables(env, univocityInstanceId);
  if (!result.ok) {
    return finish(
      result.status === 404
        ? ClientErrors.notFound("Not Found", result.detail)
        : problemResponse(
            result.status,
            result.status === 503 ? "Service Unavailable" : "Bad Gateway",
            "about:blank",
            { detail: result.detail },
          ),
    );
  }

  const body = {
    univocityInstanceId,
    creditsBalance: result.read.creditsBalance,
    checkpointsAccrued: result.read.checkpointsAccrued,
    arrears: result.read.arrears,
    enforcementFrozen: result.read.enforcementFrozen,
    registrationBlock: result.read.registrationBlock ?? null,
    watermarkBlock: result.read.watermarkBlock,
  };
  return attachCors(
    useJson ? adminJsonResponse(body, 200) : cborResponse(body, 200),
    corsHeaders,
  );
}
