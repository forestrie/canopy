/**
 * Handler for POST /api/logs/{logId}/public-root
 */

import type { Env } from "../env.js";
import { checkBearerToken } from "../auth/check-bearer-token.js";
import { base64ToBytes } from "../encoding.js";
import type { SubmitPublicRootRequest } from "../types/submit-public-root-request.js";
import {
  forwardToStore,
  internalError,
  normalizePathLogId,
  problemResponse,
} from "./handler.js";

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
    if (body.alg !== "ES256") {
      return problemResponse(
        400,
        "about:blank",
        "Invalid request",
        "alg must be ES256",
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
  } catch (error) {
    return internalError(error);
  }
}
