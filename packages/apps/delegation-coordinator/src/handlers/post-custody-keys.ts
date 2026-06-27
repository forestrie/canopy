/**
 * POST /admin/api/logs/{logId}/custody-keys — Custodian ensure-key proxy.
 *
 * Forwards CBOR to
 * [arbor custodian](https://github.com/forestrie/arbor/blob/main/services/custodian/)
 * POST /api/keys with CUSTODIAN_APP_TOKEN.
 */

import { decode, encode as encodeCbor } from "cbor-x";
import type { Env } from "../env.js";
import { requireOperatorTokenOrResponse } from "../auth/authorize.js";
import type { CustodyKeysRequest } from "../types/custody-keys-request.js";
import type { CustodyKeysResponse } from "../types/custody-keys-response.js";
import {
  internalError,
  normalizePathLogId,
  problemResponse,
} from "./handler.js";

/** Normalize custodian base URL to /v1 API prefix. */
function custodianApiBase(custodianUrl: string): string {
  const trimmed = custodianUrl.replace(/\/+$/, "");
  return trimmed.endsWith("/v1") ? trimmed : `${trimmed}/v1`;
}

/** Shared custodian ensure-key POST for admin and transitional /api route. */
async function postCustodyKeys(
  logIdHex32: string,
  body: CustodyKeysRequest,
  env: Env,
): Promise<Response> {
  if (!env.CUSTODIAN_APP_TOKEN?.trim()) {
    return problemResponse(
      503,
      "about:blank",
      "Service Unavailable",
      "CUSTODIAN_APP_TOKEN is not configured",
    );
  }

  if (!body.keyOwnerId?.trim()) {
    return problemResponse(
      400,
      "about:blank",
      "Invalid request",
      "keyOwnerId is required",
    );
  }

  const cborBody = {
    keyOwnerId: body.keyOwnerId.trim(),
    selfLogId: logIdHex32,
    alg: body.alg?.trim() || "ES256",
    protectionLevel: "SOFTWARE",
    labels: body.labels ?? {},
  };

  const encoded = encodeCbor(cborBody);
  const u8 =
    encoded instanceof Uint8Array
      ? encoded
      : new Uint8Array(encoded as ArrayLike<number>);

  const res = await fetch(`${custodianApiBase(env.CUSTODIAN_URL)}/api/keys`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.CUSTODIAN_APP_TOKEN.trim()}`,
      "Content-Type": "application/cbor",
      Accept: "application/cbor",
    },
    body: u8,
  });

  const buf = new Uint8Array(await res.arrayBuffer());
  if (!res.ok) {
    return problemResponse(
      res.status,
      "about:blank",
      "Custodian ensure key failed",
      `Custodian returned ${res.status}`,
    );
  }

  const raw = decode(buf) as Record<string, unknown>;
  const keyId = readStringField(raw, "keyId");
  const publicKey = readStringField(raw, "publicKey");
  const alg = readStringField(raw, "alg") || "ES256";

  if (!keyId || !publicKey) {
    return problemResponse(
      502,
      "about:blank",
      "Bad Gateway",
      "Custodian response missing keyId or publicKey",
    );
  }

  const response: CustodyKeysResponse = { keyId, publicKey, alg };
  return Response.json(response);
}

/** Read string field from decoded CBOR map. */
function readStringField(
  obj: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = obj[key];
  return typeof value === "string" ? value : undefined;
}

/** Admin POST custody-keys with operator token auth. */
export async function handleAdminPostCustodyKeys(
  logIdSegment: string,
  request: Request,
  env: Env,
): Promise<Response> {
  try {
    const authErr = requireOperatorTokenOrResponse(request, env);
    if (authErr) return authErr;

    const logIdHex32 = normalizePathLogId(logIdSegment);
    if (logIdHex32 instanceof Response) return logIdHex32;

    const body = (await request.json()) as CustodyKeysRequest;
    return postCustodyKeys(logIdHex32, body, env);
  } catch (error) {
    return internalError(error);
  }
}

/**
 * @deprecated Transitional alias — POST /api/logs/{logId}/custody-keys.
 */
export async function handlePostCustodyKeys(
  logIdSegment: string,
  request: Request,
  env: Env,
): Promise<Response> {
  return handleAdminPostCustodyKeys(logIdSegment, request, env);
}
