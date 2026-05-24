/**
 * Handler for POST /api/logs/{logId}/custody-keys — Custodian create-only proxy.
 */

import { decode, encode as encodeCbor } from "cbor-x";
import type { Env } from "../env.js";
import { checkBearerToken } from "../auth/check-bearer-token.js";
import type { CustodyKeysRequest } from "../types/custody-keys-request.js";
import type { CustodyKeysResponse } from "../types/custody-keys-response.js";
import {
  internalError,
  normalizePathLogId,
  problemResponse,
} from "./handler.js";

function custodianApiBase(custodianUrl: string): string {
  const trimmed = custodianUrl.replace(/\/+$/, "");
  return trimmed.endsWith("/v1") ? trimmed : `${trimmed}/v1`;
}

export async function handlePostCustodyKeys(
  logIdSegment: string,
  request: Request,
  env: Env,
): Promise<Response> {
  try {
    const authErr = checkBearerToken(request, env.COORDINATOR_APP_TOKEN);
    if (authErr) return authErr;

    if (!env.CUSTODIAN_APP_TOKEN?.trim()) {
      return problemResponse(
        503,
        "about:blank",
        "Service Unavailable",
        "CUSTODIAN_APP_TOKEN is not configured",
      );
    }

    const logIdHex32 = normalizePathLogId(logIdSegment);
    if (logIdHex32 instanceof Response) return logIdHex32;

    const body = (await request.json()) as CustodyKeysRequest;
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
        "Custodian create key failed",
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
  } catch (error) {
    return internalError(error);
  }
}

function readStringField(
  obj: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = obj[key];
  return typeof value === "string" ? value : undefined;
}
