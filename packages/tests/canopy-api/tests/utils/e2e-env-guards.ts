import { randomUUID } from "node:crypto";
import type { TestInfo } from "@playwright/test";
import { custodianBootstrapSignEnv } from "./custodian-bootstrap-sign";
import { custodianCustodySignEnv } from "./custodian-custody-grant";

/**
 * Root log UUID for e2e that **complete** a bootstrap grant and hit
 * receipt-based `grantAuthorize` (Custodian curator/log-key must resolve the
 * owner log, usually `:bootstrap` when the id matches deployment `ROOT_LOG_ID`).
 *
 * Reads `E2E_BOOTSTRAP_LOG_ID` then `ROOT_LOG_ID` (32 hex, 0x-prefix, or UUID);
 * if both unset, returns a random UUID (local dev only unless Custodian maps it).
 */
export function e2eReceiptBootstrapRootLogId(): string {
  const raw = (
    process.env.E2E_BOOTSTRAP_LOG_ID?.trim() ||
    process.env.ROOT_LOG_ID?.trim() ||
    ""
  ).replace(/^0x/i, "");
  if (!raw) return randomUUID();
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

export function skipWithoutCustodianBootstrap(testInfo: TestInfo): boolean {
  if (!custodianBootstrapSignEnv()) {
    testInfo.skip(
      true,
      "CUSTODIAN_URL and CUSTODIAN_BOOTSTRAP_APP_TOKEN required for bootstrap signing",
    );
    return true;
  }
  return false;
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
