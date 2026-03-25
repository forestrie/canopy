import type { TestInfo } from "@playwright/test";
import type { ProblemDetails } from "./problem-details";

/**
 * Plan 0014: bootstrap mint requires Custodian on the Worker. Deployments that still
 * mention DELEGATION_SIGNER_* are behind this repo; unconfigured mint returns 503.
 *
 * Default (no **`CI`**, no **`E2E_REQUIRE_BOOTSTRAP`**): **skip** when mint returns 503
 * with a "not configured" body so local `task test:e2e` stays usable while dev catches up.
 *
 * Set **`E2E_REQUIRE_BOOTSTRAP=1`** (or run with **`CI=true`**, e.g. GitHub Actions)
 * to **fail** instead of skip when bootstrap mint is unavailable.
 */
export function skipOrThrowIfBootstrapMintUnconfigured(
  status: number,
  problem: ProblemDetails | undefined,
  testInfo: TestInfo,
): "skip" | "ok" {
  if (status !== 503) return "ok";
  const haystack = `${problem?.title ?? ""} ${problem?.detail ?? ""}`;
  if (!/not configured/i.test(haystack)) return "ok";

  const strict =
    process.env.CI === "true" ||
    process.env.E2E_REQUIRE_BOOTSTRAP === "1" ||
    process.env.E2E_REQUIRE_BOOTSTRAP === "true";

  const msg =
    `Bootstrap mint not configured (${problem?.detail ?? problem?.title ?? "503"}). ` +
    `Per Plan 0014, deploy canopy-api with Worker secrets CUSTODIAN_URL and ` +
    `CUSTODIAN_BOOTSTRAP_APP_TOKEN. Legacy DELEGATION_SIGNER_* workers must be redeployed.`;

  if (strict) {
    throw new Error(msg);
  }
  testInfo.skip(true, msg);
  return "skip";
}
