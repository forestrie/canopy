/**
 * Signed webhook delivery to operator-configured URLs.
 *
 * Upstream: {@link DelegationStoreDO} enqueue on pending delegation.
 * Downstream: subscriber HTTPS endpoint; signature verified via JWKS from
 * {@link getWebhookSigningKeyInfo}. URL registration validated by
 * [@canopy/webhook-url](https://github.com/forestrie/canopy/tree/main/packages/libs/webhook-url).
 */

import type { Env } from "../env.js";
import { signWebhook } from "./signing-key.js";

/** Result of a single webhook POST attempt. */
export interface WebhookDeliveryResult {
  ok: boolean;
  status: number;
}

/**
 * POST a signed JSON payload to the configured webhook URL.
 *
 * @param env - Worker bindings (signing key).
 * @param webhookUrl - HTTPS destination from log config.
 * @param rawBody - JSON string body (already serialized event).
 * @returns Delivery outcome with HTTP status from subscriber.
 */
export async function deliverSignedWebhook(
  env: Env,
  webhookUrl: string,
  rawBody: string,
): Promise<WebhookDeliveryResult> {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const signature = await signWebhook(env, timestamp, rawBody);
  const response = await fetch(webhookUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Forestrie-Webhook-Timestamp": timestamp,
      "X-Forestrie-Webhook-Signature": signature,
    },
    body: rawBody,
  });
  return { ok: response.ok, status: response.status };
}
