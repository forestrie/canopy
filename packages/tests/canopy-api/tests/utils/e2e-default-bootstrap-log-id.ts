/**
 * Canonical bootstrap log UUID for e2e against dev/prod-like Custodian.
 * Must match canopy `ROOT_LOG_ID` / Custodian `RootLogID` so
 * `GET …/curator/log-key?logId=…` resolves `:bootstrap` after MMRS exists
 * (receipt-based register-grant).
 *
 * Override per run with `E2E_BOOTSTRAP_LOG_ID` or `ROOT_LOG_ID` when using a
 * different forest root or an isolated log on shared api-dev.
 */
export const E2E_DEFAULT_BOOTSTRAP_LOG_ID =
  "123e4567-e89b-12d3-a456-426614174000";
