/**
 * PUT /api/logs/{logId}/webhook — register an HTTPS webhook URL, an instance
 * binding, or both.
 *
 * URL validated via
 * [@canopy/webhook-url](https://github.com/forestrie/canopy/tree/main/packages/libs/webhook-url).
 *
 * `instanceKey` binds the log to a univocity instance and copies that
 * instance's webhook into the log's own config row (ADR-0005 amendment,
 * FOR-468). The copy is what keeps the delegation request path inside a single
 * shard; see {@link handlePutInstanceWebhook} for the fan-out that pays for it.
 *
 * `url` accepts either token; **`instanceKey` requires the app token**. An
 * instance is not a log, so authority over one log says nothing about the
 * instance a caller may claim to belong to.
 */

import type { Env } from "../env.js";
import { checkBearerToken } from "../auth/check-bearer-token.js";
import { issuerTokenForLog } from "../auth/issuer-token-for-log.js";
import { normalizeInstanceKey } from "../instance-key.js";
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

/** PUT validated webhook URL and/or instance binding for a log. */
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
    const rawUrl = body.url?.trim() ?? "";
    const rawInstanceKey = body.instanceKey?.trim() ?? "";
    if (!rawUrl && !rawInstanceKey) {
      return problemResponse(
        400,
        "about:blank",
        "Invalid request",
        "url or instanceKey is required",
      );
    }

    const forwarded: PutWebhookRequest = {};

    if (rawUrl) {
      try {
        forwarded.url = validateWebhookUrl(rawUrl, {
          allowInsecureLocal: env.NODE_ENV === "dev",
        });
      } catch (error) {
        const detail =
          error instanceof WebhookUrlValidationError
            ? error.message
            : "Invalid webhook url";
        return problemResponse(400, "about:blank", "Invalid request", detail);
      }
    }

    if (rawInstanceKey) {
      // Naming an instance copies that instance's webhook URL into this log's
      // row, so it must not be reachable with authority over this log alone.
      // The coordinator cannot check the claim — it treats the key as an opaque
      // label and never resolves it on chain — so a per-log issuer token could
      // otherwise name any instance, read its endpoint back off this log's
      // config, and aim `delegation.required` events at its receiver. Restrict
      // the field to the app token, which is how canopy-api always calls: it
      // derives the key from the registration record it already holds.
      if (checkBearerToken(request, env.COORDINATOR_APP_TOKEN)) {
        return problemResponse(
          403,
          "about:blank",
          "Forbidden",
          "instanceKey requires the coordinator app token",
        );
      }
      try {
        forwarded.instanceKey = normalizeInstanceKey(rawInstanceKey);
      } catch (error) {
        const detail =
          error instanceof Error ? error.message : "Invalid instanceKey";
        return problemResponse(400, "about:blank", "Invalid request", detail);
      }
    }

    return forwardToStore(env, logIdHex32, `/webhook/${logIdHex32}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(forwarded),
    });
  } catch (error) {
    return internalError(error);
  }
}
