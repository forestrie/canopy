/**
 * Env guards for Mode C webhook seal system e2e (Package D / FOR-201).
 */

import { hasCoordinatorApiE2eEnv } from "./coordinator-api-env.js";

/** True when pending-delegation pull backstop is allowed (local debug only). */
export function modeCAllowPullFallback(): boolean {
  return process.env.E2E_MODE_C_ALLOW_PULL_FALLBACK?.trim() === "1";
}

/** Explicit public HTTPS base for coordinator webhook delivery (optional). */
export function modeCWebhookPublicBaseFromEnv(): string | undefined {
  const raw = process.env.E2E_MODE_C_WEBHOOK_PUBLIC_BASE?.trim();
  return raw ? raw.replace(/\/$/, "") : undefined;
}

/** Coordinator + ops admin token required for Mode C webhook seal spec. */
export function hasModeCWebhookSealE2eEnv(): boolean {
  return (
    hasCoordinatorApiE2eEnv() &&
    Boolean(process.env.CANOPY_OPS_ADMIN_TOKEN?.trim())
  );
}

/** Human-readable skip reason when Mode C webhook seal prerequisites are missing. */
export function modeCWebhookSealSkipReason(): string | undefined {
  if (!hasCoordinatorApiE2eEnv()) {
    return (
      "Mode C webhook seal e2e requires DELEGATION_COORDINATOR_URL and " +
      "COORDINATOR_APP_TOKEN (see FOR-202 / task test:e2e:preflight)."
    );
  }
  if (!process.env.CANOPY_OPS_ADMIN_TOKEN?.trim()) {
    return (
      "Mode C webhook seal e2e requires CANOPY_OPS_ADMIN_TOKEN " +
      "(Doppler dev / GitHub dev environment)."
    );
  }
  return undefined;
}
