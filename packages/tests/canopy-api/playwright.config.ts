import { defineConfig } from "@playwright/test";
import dotenv from "dotenv";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "../../..");
const envPath = resolve(repoRoot, ".env");

function stripExportPrefixes(raw: string) {
  return raw.replace(/^\s*export\s+/gm, "");
}

if (existsSync(envPath)) {
  const parsed = dotenv.parse(
    stripExportPrefixes(readFileSync(envPath, "utf8")),
  );
  for (const [k, v] of Object.entries(parsed)) {
    process.env[k] = v;
  }
} else if (!process.env.CI) {
  throw new Error(
    "Missing repo-root .env. Run `task vars:doppler:dev` (or vars:doppler:prod), " +
      "or create .env at the repository root before running Playwright.",
  );
}

/**
 * Match `.github/workflows/test.yml` API e2e step: prefer CANOPY_BASE_URL, else https://CANOPY_FQDN.
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
    throw new Error(
      "Set CANOPY_BASE_URL or CANOPY_FQDN in repo-root .env (e.g. task vars:doppler:dev) " +
        "or export them in CI — same as .github/workflows/test.yml API e2e job.",
    );
  }
  return `https://${fq}`.replace(/\/$/, "");
}

const baseURL = resolveCanopyBaseUrl();

export default defineConfig({
  testDir: "./tests",
  timeout: 30_000,
  expect: {
    timeout: 5_000,
  },
  reporter: process.env.CI
    ? [["html", { outputFolder: "playwright-report" }]]
    : "list",
  projects: [
    {
      name: "health",
      testMatch: ["**/api.spec.ts", "**/observability.spec.ts"],
      use: {
        baseURL,
      },
    },
    {
      name: "dev",
      use: {
        baseURL,
      },
    },
    {
      // Prod / release: excludes mutating bootstrap mint tests.
      name: "prod",
      testIgnore: ["**/grants-bootstrap.spec.ts"],
      use: {
        baseURL,
      },
    },
  ],
});
