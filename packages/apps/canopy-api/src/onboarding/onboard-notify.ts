import type { OnboardNotifyEnv } from "./onboard-notify-env.js";
import type { OnboardNotifyEvent } from "./onboard-notify-event.js";

export type { OnboardNotifyEvent, OnboardNotifyEnv } from "./types.js";

/** Receiver tolerance window for webhook timestamps (seconds). */
export const ONBOARD_WEBHOOK_TOLERANCE_SEC = 300;

async function hmacSha256Hex(secret: string, payload: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(payload),
  );
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export async function emitOnboardWebhook(
  env: OnboardNotifyEnv,
  event: OnboardNotifyEvent,
  payload: Record<string, unknown>,
): Promise<void> {
  const url = env.ONBOARD_REQUEST_WEBHOOK_URL?.trim();
  if (!url) return;

  const at = Math.floor(Date.now() / 1000);
  const body = JSON.stringify({
    event,
    at,
    ...payload,
  });

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-Forestrie-Timestamp": String(at),
  };
  const secret = env.ONBOARD_REQUEST_WEBHOOK_SECRET?.trim();
  if (secret) {
    headers["X-Forestrie-Signature"] = await hmacSha256Hex(
      secret,
      `${at}.${body}`,
    );
  }

  try {
    await fetch(url, { method: "POST", headers, body });
  } catch {
    // best-effort; caller must not fail the primary request
  }
}

export function scheduleOnboardWebhook(
  ctx: { waitUntil?(p: Promise<unknown>): void },
  env: OnboardNotifyEnv,
  event: OnboardNotifyEvent,
  payload: Record<string, unknown>,
): void {
  const work = emitOnboardWebhook(env, event, payload);
  if (typeof ctx.waitUntil === "function") {
    ctx.waitUntil(work);
  }
}
