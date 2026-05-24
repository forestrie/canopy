/**
 * Handler for POST /api/delegations/material
 */

import type { Env } from "../env.js";
import { checkBearerToken } from "../auth/check-bearer-token.js";
import { normalizeLogIdToHex32 } from "../log-id.js";
import type { SubmitMaterialRequest } from "../types/submit-material-request.js";
import {
  forwardToStore,
  internalError,
  problemResponse,
} from "./handler.js";

export async function handlePostMaterial(
  request: Request,
  env: Env,
): Promise<Response> {
  try {
    const authErr = checkBearerToken(request, env.COORDINATOR_APP_TOKEN);
    if (authErr) return authErr;

    const body = (await request.json()) as SubmitMaterialRequest;
    if (
      !body.logId ||
      body.mmrStart === undefined ||
      body.mmrEnd === undefined ||
      !body.delegatedPublicKey ||
      !body.certificate
    ) {
      return problemResponse(
        400,
        "about:blank",
        "Invalid request",
        "logId, mmrStart, mmrEnd, delegatedPublicKey, and certificate are required",
      );
    }

    let logIdHex32: string;
    try {
      logIdHex32 = normalizeLogIdToHex32(body.logId);
    } catch (error) {
      return problemResponse(
        400,
        "about:blank",
        "Invalid request",
        error instanceof Error ? error.message : "Invalid logId",
      );
    }

    const payload: SubmitMaterialRequest = {
      ...body,
      logId: logIdHex32,
    };

    return forwardToStore(env, logIdHex32, "/material", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch (error) {
    return internalError(error);
  }
}
