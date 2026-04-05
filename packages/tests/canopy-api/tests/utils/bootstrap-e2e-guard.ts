import type { TestInfo } from "@playwright/test";
import type { ProblemDetails } from "./problem-details";

/**
 * Plan 0014 / 0019: Some routes still return **503** when the Worker is missing queue,
 * receipt verifier, or Custodian configuration. Legacy **bootstrap mint** on the Worker
 * is removed; e2e mint uses runner-side Custodian + `POST /api/forest/.../genesis`.
 *
 * Default (no **`CI`**, no **`E2E_REQUIRE_BOOTSTRAP`**): **skip** on select responses
 * with a "not configured" body so local `task test:e2e` stays usable while dev catches up.
 *
 * Set **`E2E_REQUIRE_BOOTSTRAP=1`** (or run with **`CI=true`**, e.g. GitHub Actions)
 * to **fail** instead of skip when the deployment looks misconfigured.
 */
function workerBootstrapOrDeployment503(
  problem: ProblemDetails | undefined,
): boolean {
  const haystack = `${problem?.title ?? ""} ${problem?.detail ?? ""}`;
  if (/not configured/i.test(haystack)) return true;
  if (!/misconfigured/i.test(haystack)) return false;
  return /CUSTODIAN_APP_TOKEN|SEQUENCING_QUEUE|CURATOR_ADMIN_TOKEN|CUSTODIAN_URL|CUSTODIAN_BOOTSTRAP|FORESTRIE_RECEIPT_VERIFY_TEST/i.test(
    haystack,
  );
}

export function skipOrThrowIfBootstrapMintUnconfigured(
  status: number,
  problem: ProblemDetails | undefined,
  testInfo: TestInfo,
): "skip" | "ok" {
  if (status !== 503) return "ok";
  if (!workerBootstrapOrDeployment503(problem)) return "ok";

  const strict =
    process.env.CI === "true" ||
    process.env.E2E_REQUIRE_BOOTSTRAP === "1" ||
    process.env.E2E_REQUIRE_BOOTSTRAP === "true";

  const msg =
    `Worker unavailable or misconfigured (${problem?.detail ?? problem?.title ?? "503"}). ` +
    `Deploy canopy-api with CUSTODIAN_URL, CUSTODIAN_BOOTSTRAP_APP_TOKEN, ` +
    `CUSTODIAN_APP_TOKEN, and SEQUENCING_QUEUE. Legacy DELEGATION_SIGNER_* ` +
    `workers must be redeployed.`;

  if (strict) {
    throw new Error(msg);
  }
  testInfo.skip(true, msg);
  return "skip";
}
