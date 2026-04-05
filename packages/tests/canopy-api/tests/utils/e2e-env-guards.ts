import type { TestInfo } from "@playwright/test";
import { custodianBootstrapSignEnv } from "./custodian-bootstrap-sign";
import { custodianCustodySignEnv } from "./custodian-custody-grant";
import { E2E_DEFAULT_BOOTSTRAP_LOG_ID } from "./e2e-default-bootstrap-log-id.js";

/**
 * Root log UUID for e2e that **complete** a bootstrap grant and hit
 * receipt-based `grantAuthorize` (Custodian `:bootstrap` when curator genesis
 * matches that log’s published COSE EC2 `x,y`).
 *
 * Reads `E2E_BOOTSTRAP_LOG_ID` then legacy `ROOT_LOG_ID` (32 hex, 0x-prefix, or UUID).
 * If both unset, uses {@link E2E_DEFAULT_BOOTSTRAP_LOG_ID} (same as canopy/Custodian
 * dev root) so Custodian can resolve receipt verify keys; use a different env log when
 * api-dev already has MMRS for the default (see AGENTS.md bootstrap caveats).
 */
export function e2eReceiptBootstrapRootLogId(): string {
  const raw = (
    process.env.E2E_BOOTSTRAP_LOG_ID?.trim() ||
    process.env.ROOT_LOG_ID?.trim() ||
    ""
  ).replace(/^0x/i, "");
  if (!raw) return E2E_DEFAULT_BOOTSTRAP_LOG_ID;
  const hex = raw.replace(/-/g, "").toLowerCase();
  if (hex.length === 32 && /^[0-9a-f]+$/.test(hex)) {
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
  }
  const lower = raw.toLowerCase();
  if (
    lower.length >= 36 &&
    lower.includes("-") &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(lower)
  ) {
    return lower;
  }
  return E2E_DEFAULT_BOOTSTRAP_LOG_ID;
}

/** True when sequencing poll tests should be skipped (no ingress). */
export function shouldSkipSequencingPoll(): boolean {
  return (
    process.env.E2E_SKIP_SEQUENCING_POLL === "1" ||
    process.env.E2E_SKIP_SEQUENCING_POLL === "true"
  );
}

export function skipSequencingPollIfDisabled(testInfo: TestInfo): boolean {
  if (shouldSkipSequencingPoll()) {
    testInfo.skip(true, "E2E_SKIP_SEQUENCING_POLL: skip until SCITT / ingress");
    return true;
  }
  return false;
}

const BOOTSTRAP_MINT_E2E_HELP =
  "Hydrate repo-root .env (task test:e2e:preflight) or run task test:e2e:doppler. " +
  "See packages/tests/canopy-api/README.md.";

/**
 * Runner-side bootstrap mint requires Custodian `:bootstrap` and curator genesis POST.
 * Call before minting; throws so the test **fails** (not skipped) when misconfigured.
 */
export function assertBootstrapMintE2eEnv(): void {
  if (!process.env.CURATOR_ADMIN_TOKEN?.trim()) {
    throw new Error(
      `CURATOR_ADMIN_TOKEN is required to POST /api/forest/{log-id}/genesis. ${BOOTSTRAP_MINT_E2E_HELP}`,
    );
  }
  if (!custodianBootstrapSignEnv()) {
    throw new Error(
      `CUSTODIAN_URL and CUSTODIAN_BOOTSTRAP_APP_TOKEN are required for bootstrap grant signing. ${BOOTSTRAP_MINT_E2E_HELP}`,
    );
  }
}

export function skipWithoutCustodianCustody(testInfo: TestInfo): boolean {
  if (!custodianCustodySignEnv()) {
    testInfo.skip(
      true,
      "CUSTODIAN_URL and CUSTODIAN_APP_TOKEN required for custody keys",
    );
    return true;
  }
  return false;
}
