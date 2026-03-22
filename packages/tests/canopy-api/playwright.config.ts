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

const baseURL = (() => {
  const raw = process.env.CANOPY_BASE_URL?.trim();
  if (!raw) {
    throw new Error(
      "CANOPY_BASE_URL is not set. For local runs use repo-root .env; " +
        "in CI export it in the job environment (e.g. GitHub Environment variables).",
    );
  }
  return raw.replace(/\/$/, "");
})();

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
      name: "dev",
      use: {
        baseURL,
      },
    },
  ],
});
