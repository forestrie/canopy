import { defineConfig } from "@playwright/test";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

process.env.CANOPY_E2E_API_TOKEN ??= "test-api";

const LOCAL_PORT = Number(
  process.env.CANOPY_E2E_LOCAL_PORT ?? detectWranglerPort() ?? 8789,
);

const repoRoot = resolve(__dirname, "../../..");

/** Remote project hits an existing deployment; do not start wrangler (avoids port/inspector clashes). */
function shouldStartLocalWebServer(): boolean {
  if (process.env.CANOPY_E2E_DISABLE_WEBSERVER === "true") {
    return false;
  }
  const a = process.argv;
  for (let i = 0; i < a.length; i++) {
    const arg = a[i];
    if (arg === "--project" && a[i + 1] === "remote") {
      return false;
    }
    if (arg.startsWith("--project=") && arg.slice("--project=".length) === "remote") {
      return false;
    }
  }
  return true;
}

/** Fast iteration: only canopy-api (no signer / univocity stub); bootstrap tests skip or fail soft. */
const useLightLocalStack = process.env.CANOPY_E2E_LIGHT_STACK === "true";

const localWebServer = useLightLocalStack
  ? {
      command: "pnpm --filter @canopy/api dev -- --test-scheduled",
      port: LOCAL_PORT,
      reuseExistingServer: true,
      timeout: 60_000,
    }
  : {
      cwd: repoRoot,
      command: `node ${resolve(repoRoot, "scripts/start-e2e-local-stack.mjs")}`,
      port: LOCAL_PORT,
      reuseExistingServer: false,
      timeout: 120_000,
    };

export default defineConfig({
  testDir: "./tests",
  timeout: 30_000,
  expect: {
    timeout: 5_000,
  },
  reporter: process.env.CI
    ? [["html", { outputFolder: "playwright-report" }]]
    : "list",
  ...(shouldStartLocalWebServer() ? { webServer: localWebServer } : {}),
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
