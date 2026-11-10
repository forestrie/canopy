import { randomUUID } from "node:crypto";
import { custodianCustodySignEnv } from "./custodian-custody-grant.js";
import { hasCoordinatorApiE2eEnv } from "./coordinator-api-env.js";
import type { E2eBootstrapVariant } from "./e2e-bootstrap-variant.js";

/**
 * New bootstrap forest log id for e2e (genesis + contract-bootstrap root grant + register).
 *
 * Always a **fresh** UUID so the first `POST /register/.../grants` hits the MMRS-cold
 * bootstrap branch on shared dev.
 */
export function e2eReceiptBootstrapRootLogId(): string {
  return randomUUID();
}

const BOOTSTRAP_MINT_E2E_HELP =
  "Run via Doppler (project canopy, config dev or prod), e.g. task test:e2e. " +
  "See packages/tests/canopy-api/README.md.";

/**
 * Root bootstrap mint requires the ops onboard token and univocity chain
 * binding switched on. The contract and its bootstrap key come from the
 * variant ({@link E2eBootstrapVariant}), which throws when its contract
 * (pooled or pinned by env) or key is not configured.
 */
export function assertBootstrapMintE2eEnv(): void {
  if (!process.env.CANOPY_OPS_ADMIN_TOKEN?.trim()) {
    throw new Error(
      `CANOPY_OPS_ADMIN_TOKEN is required to mint onboard tokens for POST /api/forest/{log-id}/genesis. ${BOOTSTRAP_MINT_E2E_HELP}`,
    );
  }
  if (process.env.E2E_SKIP_UNIVOCITY_CHAIN_BINDING?.trim() === "true") {
    throw new Error(
      `Univocity provision skipped (SKIP_UNIVOCITY_PROVISION). ${BOOTSTRAP_MINT_E2E_HELP}`,
    );
  }
}

/**
 * Receipt-polling bootstrap specs need coordinator env so Playwright can
 * upload wallet-signed delegation material for contract-bootstrap root logs.
 */
export function assertBootstrapReceiptE2eEnv(): void {
  assertBootstrapMintE2eEnv();
  if (!hasCoordinatorApiE2eEnv()) {
    throw new Error(
      "DELEGATION_COORDINATOR_URL and COORDINATOR_APP_TOKEN are required " +
        "for bootstrap receipt polling (coordinator delegation material loop). " +
        BOOTSTRAP_MINT_E2E_HELP,
    );
  }
}

/**
 * Full **system** e2e (SCRAPI + Custodian for child keys + ops onboard token + Univocity provision).
 */
export function assertSystemE2eEnv(): void {
  assertBootstrapReceiptE2eEnv();
  if (!custodianCustodySignEnv()) {
    throw new Error(
      `CUSTODIAN_URL and CUSTODIAN_APP_TOKEN are required for child custody keys. ${BOOTSTRAP_MINT_E2E_HELP}`,
    );
  }
}
