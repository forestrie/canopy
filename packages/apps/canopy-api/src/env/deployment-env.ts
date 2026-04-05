import { problemResponse } from "../scrapi/cbor-response";
import { isCanopyApiPoolTestMode } from "./runtime-mode";

/** Subset of Env needed to validate Custodian bootstrap trio for grant paths. */
export interface CanopyBootstrapTrioEnv {
  NODE_ENV: string;
  ROOT_LOG_ID?: string;
  CUSTODIAN_URL?: string;
  CUSTODIAN_BOOTSTRAP_APP_TOKEN?: string;
}

/**
 * Non-pool workers must have ROOT_LOG_ID, CUSTODIAN_URL (non-empty), and
 * CUSTODIAN_BOOTSTRAP_APP_TOKEN. Returns a 503 problem response if not.
 */
export function responseIfBootstrapTrioIncomplete(
  env: CanopyBootstrapTrioEnv,
  corsHeaders: Record<string, string>,
): Response | null {
  if (isCanopyApiPoolTestMode(env)) {
    return null;
  }
  const missing: string[] = [];
  if (!env.ROOT_LOG_ID?.trim()) missing.push("ROOT_LOG_ID");
  if (!env.CUSTODIAN_URL?.trim()) missing.push("CUSTODIAN_URL");
  if (!env.CUSTODIAN_BOOTSTRAP_APP_TOKEN?.trim()) {
    missing.push("CUSTODIAN_BOOTSTRAP_APP_TOKEN");
  }
  if (missing.length === 0) return null;

  return problemResponse(503, "Service Unavailable", "about:blank", {
    detail: `Canopy API is misconfigured (missing ${missing.join(", ")}).`,
    headers: corsHeaders,
  });
}
