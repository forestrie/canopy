import { defineConfig } from "@playwright/test";
import { E2E_SYSTEM_TEST_TIMEOUT_MS } from "./tests/utils/arithmetic-backoff-poll.js";

const DOPPLER_E2E_HINT =
  "Inject secrets with Doppler (project canopy, config dev or prod), e.g.\n" +
  "  task test:e2e\n" +
  "  doppler run --project canopy --config dev -- pnpm --filter @canopy/api-e2e test:e2e\n" +
  "See taskfiles/e2e-setup.md and packages/tests/canopy-api/README.md.";

/**
 * Match `.github/workflows/tests-system.yml`: prefer CANOPY_BASE_URL, else https://CANOPY_FQDN.
 * Doppler `dev` often supplies CANOPY_FQDN only.
 */
function resolveCanopyBaseUrl(): string {
  const trim = (s: string | undefined) => (s ?? "").trim();
  const direct = trim(process.env.CANOPY_BASE_URL);
  if (direct) return direct.replace(/\/$/, "");

  let fq = trim(process.env.CANOPY_FQDN);
  fq = fq.replace(/^https?:\/\//i, "");
  fq = (fq.split("/")[0] ?? "").replace(/\/$/, "");
  if (!fq) {
    if (!process.env.CI) {
      throw new Error(
        `Set CANOPY_BASE_URL or CANOPY_FQDN via Doppler before running Playwright locally.\n${DOPPLER_E2E_HINT}`,
      );
    }
    throw new Error(
      "Set CANOPY_BASE_URL or CANOPY_FQDN in CI — same as .github/workflows/tests-system.yml.",
    );
  }
  return `https://${fq}`.replace(/\/$/, "");
}

const baseURL = resolveCanopyBaseUrl();

export default defineConfig({
  globalSetup: "./global-setup.ts",
  globalTeardown: "./global-teardown.ts",
  testDir: "./tests",
  timeout: 30_000,
  retries: process.env.CI ? 2 : 0,
  expect: {
    timeout: 5_000,
  },
  reporter: process.env.CI
    ? [["html", { outputFolder: "playwright-report" }]]
    : "list",
  projects: [
    {
      name: "integration",
      testMatch: ["**/integration/**/*.spec.ts"],
      use: {
        baseURL,
      },
    },
    {
      name: "system",
      testMatch: ["**/system/**/*.spec.ts"],
      timeout: E2E_SYSTEM_TEST_TIMEOUT_MS,
      // Serial: parallel genesis POSTs stress Worker→univocity and flake 502.
      workers: 1,
      use: {
        baseURL,
      },
    },
    {
      name: "custodian",
      testMatch: ["**/custodian/**/*.spec.ts"],
      use: {
        baseURL,
      },
    },
    {
      name: "coordinator",
      testMatch: ["**/coordinator/**/*.spec.ts"],
      use: {
        baseURL,
      },
    },
    {
      // Prod / release: excludes mutating system tests.
      name: "prod",
      testMatch: ["**/*.spec.ts"],
      testIgnore: [
        "**/system/grants-bootstrap.spec.ts",
        "**/system/bootstrap-log-first-entry.spec.ts",
        "**/system/bootstrap-child-auth-grant.spec.ts",
        "**/system/auth-data-log-chain.spec.ts",
      ],
      use: {
        baseURL,
      },
    },
  ],
});
