import { problemResponse } from "../cbor-api/cbor-response.js";
import { isCanopyApiPoolTestMode } from "./runtime-mode";

function pathnameIsForestAdmin(pathname: string): boolean {
  return pathname === "/api/forest" || pathname.startsWith("/api/forest/");
}

/** `/api/forest/**` readiness: curator admin token only (no ROOT_LOG_ID). */
export interface CanopyAdminEnv {
  NODE_ENV: string;
  CURATOR_ADMIN_TOKEN?: string;
}

/**
 * Non-pool workers serving `/api/forest/**` need CURATOR_ADMIN_TOKEN.
 */
export function responseIfForestAdminIncomplete(
  env: CanopyAdminEnv,
  corsHeaders: Record<string, string>,
): Response | null {
  if (isCanopyApiPoolTestMode(env)) {
    return null;
  }
  if (!env.CURATOR_ADMIN_TOKEN?.trim()) {
    return problemResponse(503, "Service Unavailable", "about:blank", {
      detail:
        "Canopy API is misconfigured (missing CURATOR_ADMIN_TOKEN; required for /api/forest admin routes).",
      headers: corsHeaders,
    });
  }
  return null;
}

/** Env slice required for {@link checkRequestEnv} (structural typing with worker `Env`). */
export type CanopyCheckRequestEnv = CanopyAdminEnv &
  CanopyBootstrapTrioEnv &
  CanopySequencingEnv &
  CanopyReceiptVerifierEnv;

/**
 * Route-aware deployment readiness: `/api/forest/**` needs only {@link CanopyAdminEnv};
 * all other routes keep bootstrap trio + sequencing + receipt verifier checks.
 */
export function checkRequestEnv(
  request: Request,
  env: CanopyCheckRequestEnv,
  corsHeaders: Record<string, string>,
): Response | null {
  if (isCanopyApiPoolTestMode(env)) {
    return null;
  }
  const pathname = new URL(request.url).pathname;
  if (pathnameIsForestAdmin(pathname)) {
    return responseIfForestAdminIncomplete(env, corsHeaders);
  }
  const trio = responseIfBootstrapTrioIncomplete(env, corsHeaders);
  if (trio) return trio;
  const queue = responseIfSequencingQueueIncomplete(env, corsHeaders);
  if (queue) return queue;
  return responseIfReceiptVerifierMisconfigured(env, corsHeaders);
}

/** Subset of Env needed to validate Custodian URL for grant paths (receipt path uses APP_TOKEN separately). */
export interface CanopyBootstrapTrioEnv {
  NODE_ENV: string;
  CUSTODIAN_URL?: string;
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
 * Non-pool workers must have CUSTODIAN_URL (non-empty). Bootstrap grants are
 * verified against forest genesis + grantData; per-log Custodian keys use APP_TOKEN on receipt paths.
 */
export function responseIfBootstrapTrioIncomplete(
  env: CanopyBootstrapTrioEnv,
  corsHeaders: Record<string, string>,
): Response | null {
  if (isCanopyApiPoolTestMode(env)) {
    return null;
  }
  if (env.CUSTODIAN_URL?.trim()) return null;

  return problemResponse(503, "Service Unavailable", "about:blank", {
    detail: "Canopy API is misconfigured (missing CUSTODIAN_URL).",
    headers: corsHeaders,
  });
}
