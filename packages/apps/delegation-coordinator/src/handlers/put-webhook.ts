/**
 * PUT /api/logs/{logId}/webhook — register HTTPS webhook URL.
 *
 * URL validated via
 * [@canopy/webhook-url](https://github.com/forestrie/canopy/tree/main/packages/libs/webhook-url).
 */

import type { Env } from "../env.js";
import { checkBearerToken } from "../auth/check-bearer-token.js";
import { issuerTokenForLog } from "../auth/issuer-token-for-log.js";
import type { PutWebhookRequest } from "../types/put-webhook-request.js";
import {
  WebhookUrlValidationError,
  validateWebhookUrl,
} from "../validate-webhook-url.js";
import {
  forwardToStore,
  internalError,
  normalizePathLogId,
  problemResponse,
} from "./handler.js";

/** PUT validated webhook URL for delegation.required events. */
export async function handlePutWebhook(
  logIdSegment: string,
  request: Request,
  env: Env,
): Promise<Response> {
  try {
    const logIdHex32 = normalizePathLogId(logIdSegment);
    if (logIdHex32 instanceof Response) return logIdHex32;

    const issuerToken = await issuerTokenForLog(env, logIdHex32);
    const authErr = checkBearerToken(
      request,
      env.COORDINATOR_APP_TOKEN,
      issuerToken,
    );
    if (authErr) return authErr;

    const body = (await request.json()) as PutWebhookRequest;
    let validatedUrl: string;
    try {
      validatedUrl = validateWebhookUrl(body.url ?? "", {
        allowInsecureLocal: env.NODE_ENV === "dev",
      });
    } catch (error) {
      const detail =
        error instanceof WebhookUrlValidationError
          ? error.message
          : "Invalid webhook url";
      return problemResponse(400, "about:blank", "Invalid request", detail);
    }

    return forwardToStore(env, logIdHex32, `/webhook/${logIdHex32}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: validatedUrl }),
    });
  } catch (error) {
    return internalError(error);
  }
}
