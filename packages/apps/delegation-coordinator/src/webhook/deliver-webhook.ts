import type { Env } from "../env.js";
import { signWebhook } from "./signing-key.js";

export interface WebhookDeliveryResult {
  ok: boolean;
  status: number;
}

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
