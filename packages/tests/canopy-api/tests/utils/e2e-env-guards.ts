import { randomUUID } from "node:crypto";
import { custodianCustodySignEnv } from "./custodian-custody-grant.js";

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

const BOOTSTRAP_MINT_E2E_HELP =
  "Hydrate repo-root .env (task test:e2e:preflight) or run task test:e2e:doppler. " +
  "See packages/tests/canopy-api/README.md.";

/**
 * Runner-side bootstrap mint requires Custodian custody (`POST /api/keys` + sign) and curator genesis.
 * Call before minting; throws so the test **fails** when misconfigured.
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

/**
 * Full **system** e2e (SCRAPI + Custodian custody + curator): same requirements as bootstrap mint.
 */
export function assertSystemE2eEnv(): void {
  assertBootstrapMintE2eEnv();
}
