/**
 * Well-known log UUIDs for e2e suites that are safe to reuse across runs.
 * KMS CryptoKey id === normalized selfLogId (32 hex).
 */

/**
 * Univocity genesis chain-binding (persistent genesis 201/409).
 * Mnemonic UUID embeds ImutableUnivocity `0x7A4E8ad8…` (Base Sepolia Safe KS256).
 */
export const E2E_STATIC_UNIVOCITY_GENESIS_LOG_ID =
  "7a4e8ad8-8d6d-429f-8bec-0d546d148edb";

/** Custodian HTTP API direct e2e (ensure/sign/list; not deleted on teardown). */
export const E2E_STATIC_CUSTODIAN_API_LOG_ID =
  "c0ffee00-0002-4000-8000-000000000002";

/** Labels for static custody keys — no e2e-run-id; excluded from globalTeardown. */
export function e2eStaticCustodianKeyLabels(): Record<string, string> {
  return { "e2e-static-key": "true", "e2e-test-key": "true" };
}
