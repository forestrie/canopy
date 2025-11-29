import { defineConfig } from "@playwright/test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

process.env.CANOPY_E2E_API_TOKEN ??= "test-api";

const LOCAL_PORT = Number(
  process.env.CANOPY_E2E_LOCAL_PORT ?? detectWranglerPort() ?? 8789,
);

export default defineConfig({
  testDir: "./tests",
  timeout: 30_000,
  expect: {
    timeout: 5_000,
  },
  reporter: process.env.CI
    ? [["html", { outputFolder: "playwright-report" }]]
    : "list",
  webServer: {
    command: "pnpm --filter @canopy/api dev -- --test-scheduled",
    port: LOCAL_PORT,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
  projects: [
    {
      name: "local",
      use: {
        baseURL: `http://127.0.0.1:${LOCAL_PORT}`,
      },
    },
    {
      name: "remote",
      use: {
        baseURL:
          process.env.CANOPY_E2E_BASE_URL ??
          //"https://canopy-api-robin-dev.dev.forestrie.com",
          // "https://canopy-api-robin-dev.dev.forestrie.com",
          "https://canopy-api.robinbryce.workers.dev",
      },
    },
  ],
});

function detectWranglerPort(): number | undefined {
  try {
    const wranglerConfigPath = resolve(
      __dirname,
      "../../apps/canopy-api/wrangler.jsonc",
    );
    const raw = readFileSync(wranglerConfigPath, "utf8");
    const match = raw.match(/"port"\s*:\s*(\d+)/);
    if (match) {
      return Number.parseInt(match[1], 10);
    }
  } catch {
    // ignore - fall through to default
  }
  return undefined;
}
