import { problemResponse } from "../scrapi/cbor-response";
import { isCanopyApiPoolTestMode } from "./runtime-mode";

/** Subset of Env needed to validate Custodian bootstrap trio for grant paths. */
export interface CanopyBootstrapTrioEnv {
  NODE_ENV: string;
  ROOT_LOG_ID?: string;
  CUSTODIAN_URL?: string;
  CUSTODIAN_BOOTSTRAP_APP_TOKEN?: string;
}

/** Env slice for mandatory sequencing queue outside Vitest pool workers. */
export interface CanopySequencingEnv {
  NODE_ENV: string;
  SEQUENCING_QUEUE?: unknown;
}

/**
 * Non-pool workers must bind SEQUENCING_QUEUE. Pool tests may omit it.
 */
export function responseIfSequencingQueueIncomplete(
  env: CanopySequencingEnv,
  corsHeaders: Record<string, string>,
): Response | null {
  if (isCanopyApiPoolTestMode(env)) {
    return null;
  }
  if (!env.SEQUENCING_QUEUE) {
    return problemResponse(503, "Service Unavailable", "about:blank", {
      detail:
        "Canopy API is misconfigured (missing SEQUENCING_QUEUE durable object binding).",
      headers: corsHeaders,
    });
  }
  return null;
}

/** Env slice for receipt COSE verification readiness (Custodian app token). */
export interface CanopyReceiptVerifierEnv {
  NODE_ENV: string;
  CUSTODIAN_APP_TOKEN?: string;
  /** Test-only; must not be set outside pool mode (footgun guard). */
  FORESTRIE_RECEIPT_VERIFY_TEST_ES256_XY_HEX?: string;
}

/**
 * Non-pool workers need CUSTODIAN_APP_TOKEN to resolve per-log receipt verify keys.
 * Setting FORESTRIE_RECEIPT_VERIFY_TEST_ES256_XY_HEX outside pool mode is a 503.
 */
export function responseIfReceiptVerifierMisconfigured(
  env: CanopyReceiptVerifierEnv,
  corsHeaders: Record<string, string>,
): Response | null {
  if (isCanopyApiPoolTestMode(env)) {
    return null;
  }
  if (env.FORESTRIE_RECEIPT_VERIFY_TEST_ES256_XY_HEX?.trim()) {
    return problemResponse(503, "Service Unavailable", "about:blank", {
      detail:
        "Canopy API is misconfigured (FORESTRIE_RECEIPT_VERIFY_TEST_ES256_XY_HEX is set outside worker test mode).",
      headers: corsHeaders,
    });
  }
  if (!env.CUSTODIAN_APP_TOKEN?.trim()) {
    return problemResponse(503, "Service Unavailable", "about:blank", {
      detail:
        "Canopy API is misconfigured (missing CUSTODIAN_APP_TOKEN; required for SCITT receipt verification).",
      headers: corsHeaders,
    });
  }
  return null;
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
