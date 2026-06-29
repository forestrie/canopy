import { randomUUID } from "node:crypto";
import { custodianCustodySignEnv } from "./custodian-custody-grant.js";
import { hasCoordinatorApiE2eEnv } from "./coordinator-api-env.js";
import { univocityProvisionSkipReason } from "./univocity-genesis-e2e.js";

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

/** Manifest KS256 placeholder — Lane A may pin ES256 only until KS256 deploy exists. */
const KS256_MANIFEST_PLACEHOLDER =
  "0x0000000000000000000000000000000000000002";

/** KS256 bootstrap signing material is required when a real KS256 contract is pinned. */
export function ks256BootstrapMaterialRequired(): boolean {
  const addr = process.env.E2E_UNIVOCITY_ADDRESS_KS256_BOOTSTRAP?.trim();
  if (!addr) return false;
  return addr.toLowerCase() !== KS256_MANIFEST_PLACEHOLDER;
}

/**
 * Root bootstrap mint requires ops onboard token + ephemeral Imutable provision
 * (ES256/KS256 contract addresses and bootstrap signing material).
 */
export function assertBootstrapMintE2eEnv(): void {
  if (!process.env.CANOPY_OPS_ADMIN_TOKEN?.trim()) {
    throw new Error(
      `CANOPY_OPS_ADMIN_TOKEN is required to mint onboard tokens for POST /api/forest/{log-id}/genesis. ${BOOTSTRAP_MINT_E2E_HELP}`,
    );
  }
  const skip = univocityProvisionSkipReason();
  if (skip) {
    throw new Error(`${skip}. ${BOOTSTRAP_MINT_E2E_HELP}`);
  }
  if (!process.env.E2E_UNIVOCITY_ES256_BOOTSTRAP_PEM_FILE?.trim()) {
    throw new Error(
      `E2E_UNIVOCITY_ES256_BOOTSTRAP_PEM_FILE is required for ES256 root grants. ${BOOTSTRAP_MINT_E2E_HELP}`,
    );
  }
  if (
    ks256BootstrapMaterialRequired() &&
    !process.env.E2E_UNIVOCITY_KS256_BOOTSTRAP_KEY_FILE?.trim()
  ) {
    throw new Error(
      `E2E_UNIVOCITY_KS256_BOOTSTRAP_KEY_FILE is required for KS256 root grants. ${BOOTSTRAP_MINT_E2E_HELP}`,
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
