/**
 * PUT /api/logs/{logId}/webhook — register an HTTPS webhook URL, an instance
 * binding, or both.
 *
 * URL validated via
 * [@canopy/webhook-url](https://github.com/forestrie/canopy/tree/main/packages/libs/webhook-url).
 *
 * `univocityInstanceId` binds the log to a univocity instance and copies that
 * instance's webhook into the log's own config row (ADR-0005 amendment,
 * FOR-468). The copy is what keeps the delegation request path inside a single
 * shard; see {@link handlePutInstanceWebhook} for the fan-out that pays for it.
 * `instanceKey` is accepted as a deprecated alias for one deploy cycle
 * (plan-2607-43 slice 01; dropped in slice 05); values under either name are
 * canonical CAIP-10 (ADR-0059 D1/D6), with legacy value forms converted for
 * the same deploy window (plan-2607-02 R5). This handler is the only place
 * legacy values are accepted: the deploy-window sender is old canopy-api's
 * genesis forward, which lands here.
 *
 * `url` accepts either token; **`univocityInstanceId` requires the app
 * token**. An instance is not a log, so authority over one log says nothing
 * about the instance a caller may claim to belong to.
 */

import {
  isUnivocityInstanceId,
  parseUnivocityInstanceId,
} from "@canopy/univocity-instance-id";
import { univocityInstanceIdFromLegacyInstanceKey } from "../legacy-instance-id.js";
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
    const rawUnivocityInstanceId = body.univocityInstanceId?.trim() ?? "";
    const rawLegacyInstanceKey = body.instanceKey?.trim() ?? "";
    if (rawLegacyInstanceKey) {
      // Compatibility shim, dropped in plan-2607-43 slice 05.
      console.warn(
        "deprecated field instanceKey on PUT /api/logs/{logId}/webhook; send univocityInstanceId",
      );
    }
    if (
      rawUnivocityInstanceId &&
      rawLegacyInstanceKey &&
      rawUnivocityInstanceId !== rawLegacyInstanceKey
    ) {
      // Silently preferring one field would mask a sender bug for as long as
      // the alias survives; two names may only ever carry one value.
      return problemResponse(
        400,
        "about:blank",
        "Invalid request",
        "univocityInstanceId and deprecated instanceKey disagree; send one value",
      );
    }
    const rawInstanceId = rawUnivocityInstanceId || rawLegacyInstanceKey;
    if (!rawUrl && !rawInstanceId) {
      return problemResponse(
        400,
        "about:blank",
        "Invalid request",
        "url or univocityInstanceId is required",
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

    if (rawInstanceId) {
      // Naming an instance copies that instance's webhook URL into this log's
      // row, so it must not be reachable with authority over this log alone.
      // The coordinator cannot check the claim — it treats the id as an opaque
      // label and never resolves it on chain — so a per-log issuer token could
      // otherwise name any instance, read its endpoint back off this log's
      // config, and aim `delegation.required` events at its receiver. Restrict
      // the field — under either name — to the app token, which is how
      // canopy-api always calls: it derives the id from the registration
      // record it already holds.
      if (checkBearerToken(request, env.COORDINATOR_APP_TOKEN)) {
        return problemResponse(
          403,
          "about:blank",
          "Forbidden",
          "univocityInstanceId requires the coordinator app token",
        );
      }
      let instanceId = rawInstanceId;
      if (!isUnivocityInstanceId(instanceId)) {
        // Value-form shim for the coordinator-first deploy window: old
        // canopy-api's genesis forward still sends legacy-form values
        // (plan-2607-02 R5). Drops in plan-2607-43 slice 05.
        const converted = univocityInstanceIdFromLegacyInstanceKey(instanceId);
        if (converted) {
          console.warn(
            "legacy instance id form on PUT /api/logs/{logId}/webhook; send canonical CAIP-10",
          );
          instanceId = converted;
        }
      }
      try {
        forwarded.univocityInstanceId = parseUnivocityInstanceId(instanceId);
      } catch (error) {
        const detail =
          error instanceof Error
            ? error.message
            : "Invalid univocityInstanceId";
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
