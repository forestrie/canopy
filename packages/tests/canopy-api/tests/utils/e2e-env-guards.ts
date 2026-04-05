import { randomUUID } from "node:crypto";
import type { TestInfo } from "@playwright/test";
import { custodianCustodySignEnv } from "./custodian-custody-grant";

/**
 * New bootstrap forest log id for e2e (runner-side genesis + custody mint + register).
 *
 * Always a **fresh** UUID so the first `POST /register/.../grants` hits the MMRS-cold
 * bootstrap branch on shared dev. Receipt and follow-on grants use the same id returned
 * from a single call site per describe block (or one `randomUUID()` per test).
 */
export function e2eReceiptBootstrapRootLogId(): string {
  return randomUUID();
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
 * Runner-side bootstrap mint requires Custodian custody (`POST /api/keys` + sign) and curator genesis.
 * Call before minting; throws so the test **fails** (not skipped) when misconfigured.
 */
export function assertBootstrapMintE2eEnv(): void {
  if (!process.env.CURATOR_ADMIN_TOKEN?.trim()) {
    throw new Error(
      `CURATOR_ADMIN_TOKEN is required to POST /api/forest/{log-id}/genesis. ${BOOTSTRAP_MINT_E2E_HELP}`,
    );
  }
  if (!custodianCustodySignEnv()) {
    throw new Error(
      `CUSTODIAN_URL and CUSTODIAN_APP_TOKEN are required for bootstrap grant signing. ${BOOTSTRAP_MINT_E2E_HELP}`,
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
