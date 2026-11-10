import { problemResponse } from "../cbor-api/cbor-response.js";
import type { CanopyCheckRequestEnv } from "./canopy-check-request-env.js";
import type { CanopyOpsAdminEnv } from "./canopy-ops-admin-env.js";
import type { CanopyReceiptVerifierEnv } from "./canopy-receipt-verifier-env.js";
import type { CanopySequencingEnv } from "./canopy-sequencing-env.js";
import { isCanopyApiPoolTestMode } from "./runtime-mode";

function pathnameIsOnboardingRoute(pathname: string): boolean {
  return (
    pathname === "/api/onboarding" || pathname.startsWith("/api/onboarding/")
  );
}

function pathnameIsForestRoute(pathname: string): boolean {
  return pathname === "/api/forest" || pathname.startsWith("/api/forest/");
}

function pathnameIsPaymentsOps(pathname: string): boolean {
  return pathname === "/api/payments" || pathname.startsWith("/api/payments/");
}

export type {
  CanopyCheckRequestEnv,
  CanopyOpsAdminEnv,
  CanopyReceiptVerifierEnv,
  CanopySequencingEnv,
} from "./types.js";

/**
 * Non-pool workers serving `/api/payments/**` need CANOPY_OPS_ADMIN_TOKEN.
 */
export function responseIfPaymentsOpsIncomplete(
  env: CanopyOpsAdminEnv,
  corsHeaders: Record<string, string>,
): Response | null {
  if (isCanopyApiPoolTestMode(env)) {
    return null;
  }
  if (!env.CANOPY_OPS_ADMIN_TOKEN?.trim()) {
    return problemResponse(503, "Service Unavailable", "about:blank", {
      detail:
        "Canopy API is misconfigured (missing CANOPY_OPS_ADMIN_TOKEN; required for /api/payments ops routes).",
      headers: corsHeaders,
    });
  }
  return null;
}

/**
 * Route-aware deployment readiness: `/api/payments/**` needs ops admin token;
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
  if (pathnameIsPaymentsOps(pathname)) {
    return responseIfPaymentsOpsIncomplete(env, corsHeaders);
  }
  if (pathnameIsForestRoute(pathname)) {
    return null;
  }
  if (pathnameIsOnboardingRoute(pathname)) {
    return null;
  }
  const queue = responseIfSequencingQueueIncomplete(env, corsHeaders);
  if (queue) return queue;
  return responseIfReceiptVerifierMisconfigured(env, corsHeaders);
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

/**
 * Non-pool workers need UNIVOCITY_SERVICE_URL: univocity is the only source of
 * log root keys, for receipt verification and admission
 * ([devdocs ADR-0075](https://github.com/forestrie/devdocs/blob/main/adr/adr-0075-sec-child-root-claimed-once.md)
 * decision 5). Setting FORESTRIE_RECEIPT_VERIFY_TEST_ES256_XY_HEX outside pool
 * mode is a 503.
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
  if (!env.UNIVOCITY_SERVICE_URL?.trim()) {
    return problemResponse(503, "Service Unavailable", "about:blank", {
      detail:
        "Canopy API is misconfigured (missing UNIVOCITY_SERVICE_URL; required for log authority and SCITT receipt verification).",
      headers: corsHeaders,
    });
  }
  return null;
}
