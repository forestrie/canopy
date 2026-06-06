/**
 * Well-known log UUIDs for e2e suites that are safe to reuse across runs.
 * KMS CryptoKey id === normalized selfLogId (32 hex).
 */

/** Univocity genesis chain-binding (persistent genesis 201/409). */
export const E2E_STATIC_UNIVOCITY_GENESIS_LOG_ID =
  "b1a50611-dd70-42d3-9c87-611dd70b2441";

/** Custodian HTTP API direct e2e (ensure/sign/list; not deleted on teardown). */
export const E2E_STATIC_CUSTODIAN_API_LOG_ID =
  "c0ffee00-0002-4000-8000-000000000002";

/** Labels for static custody keys — no e2e-run-id; excluded from globalTeardown. */
export function e2eStaticCustodianKeyLabels(): Record<string, string> {
  return { "e2e-static-key": "true", "e2e-test-key": "true" };
}
