import type { TestInfo } from "@playwright/test";
import { custodianBootstrapSignEnv } from "./custodian-bootstrap-sign";
import { custodianCustodySignEnv } from "./custodian-custody-grant";

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
