/**
 * Handler for POST /api/logs/{logId}/public-root
 */

import type { Env } from "../env.js";
import { checkBearerToken } from "../auth/check-bearer-token.js";
import { base64ToBytes } from "../encoding.js";
import type { SubmitPublicRootRequest } from "../types/submit-public-root-request.js";
import {
  COSE_ALG_ES256,
  COSE_ALG_KS256,
} from "../types/trust-root-response.js";
import {
  forwardToStore,
  internalError,
  normalizePathLogId,
  problemResponse,
} from "./handler.js";

function parseAlg(raw: SubmitPublicRootRequest["alg"]): number | "ES256" | null {
  if (raw === "ES256") return "ES256";
  if (typeof raw === "number" && Number.isInteger(raw)) return raw;
  return null;
}

export async function handlePostPublicRoot(
  logIdSegment: string,
  request: Request,
  env: Env,
): Promise<Response> {
  try {
    const authErr = checkBearerToken(request, env.COORDINATOR_APP_TOKEN);
    if (authErr) return authErr;

    const logIdHex32 = normalizePathLogId(logIdSegment);
    if (logIdHex32 instanceof Response) return logIdHex32;

    const body = (await request.json()) as SubmitPublicRootRequest;
    const alg = parseAlg(body.alg);
    if (alg === null) {
      return problemResponse(
        400,
        "about:blank",
        "Invalid request",
        "alg must be ES256, -7, or -65799",
      );
    }

    if (alg === "ES256") {
      if (!body.x || !body.y) {
        return problemResponse(
          400,
          "about:blank",
          "Invalid request",
          "x and y are required for ES256",
        );
      }
      let x: Uint8Array;
      let y: Uint8Array;
      try {
        x = base64ToBytes(body.x);
        y = base64ToBytes(body.y);
      } catch {
        return problemResponse(
          400,
          "about:blank",
          "Invalid request",
          "x and y must be valid base64",
        );
      }
      if (x.length !== 32 || y.length !== 32) {
        return problemResponse(
          400,
          "about:blank",
          "Invalid request",
          "x and y must each decode to 32 bytes",
        );
      }
      return forwardToStore(env, logIdHex32, `/public-root/${logIdHex32}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          logIdHex32,
          alg: body.alg,
          x: body.x,
          y: body.y,
        }),
      });
    }

    if (!body.key) {
      return problemResponse(
        400,
        "about:blank",
        "Invalid request",
        "key is required for alg int public roots",
      );
    }
    let key: Uint8Array;
    try {
      key = base64ToBytes(body.key);
    } catch {
      return problemResponse(
        400,
        "about:blank",
        "Invalid request",
        "key must be valid base64",
      );
    }
    const expectedLen = alg === COSE_ALG_KS256 ? 20 : alg === COSE_ALG_ES256 ? 64 : 0;
    if (expectedLen === 0) {
      return problemResponse(
        400,
        "about:blank",
        "Invalid request",
        "alg must be ES256, -7, or -65799",
      );
    }
    if (key.length !== expectedLen) {
      return problemResponse(
        400,
        "about:blank",
        "Invalid request",
        `key must decode to ${expectedLen} bytes for alg ${alg}`,
      );
    }

    return forwardToStore(env, logIdHex32, `/public-root/${logIdHex32}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        logIdHex32,
        alg: body.alg,
        key: body.key,
      }),
    });
  } catch (error) {
    return internalError(error);
  }
}
