#!/usr/bin/env node
/**
 * Start delegation-signer (test key) and canopy-api for e2e local tests.
 * Used by Playwright webServer in CI so the bootstrap mint test can run.
 * Waits for both ports then keeps running until SIGTERM; kills children on exit.
 */

import { spawn } from "node:child_process";

const DELEGATION_SIGNER_PORT = 8791;
const CANOPY_API_PORT = 8789;
const ROOT_LOG_ID = "123e4567e89b12d3a456426614174000";

async function waitForPort(port, label, maxWaitMs = 30_000) {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (r.ok) return;
    } catch (_) {}
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`${label} did not become ready on port ${port}`);
}

async function main() {
  const children = [];

  const killChildren = () => {
    for (const c of children) {
      try {
        c.kill("SIGTERM");
      } catch (_) {}
    }
    process.exit(0);
  };
  process.on("SIGTERM", killChildren);
  process.on("SIGINT", killChildren);

  // Start delegation-signer (test key); ensure .dev.vars exists
  const fs = await import("node:fs");
  if (
    !fs.existsSync("packages/apps/delegation-signer/.dev.vars") &&
    fs.existsSync("packages/apps/delegation-signer/.dev.vars.example")
  ) {
    fs.copyFileSync(
      "packages/apps/delegation-signer/.dev.vars.example",
      "packages/apps/delegation-signer/.dev.vars",
    );
  }
  const ds = spawn("pnpm", ["--filter", "@canopy/delegation-signer", "dev"], {
    cwd: process.cwd(),
    stdio: "pipe",
    env: { ...process.env },
  });
  children.push(ds);
  ds.stdout?.on("data", (d) => process.stdout.write(d));
  ds.stderr?.on("data", (d) => process.stderr.write(d));

  await waitForPort(DELEGATION_SIGNER_PORT, "delegation-signer");

  const apiEnv = {
    ...process.env,
    DELEGATION_SIGNER_URL: `http://127.0.0.1:${DELEGATION_SIGNER_PORT}`,
    DELEGATION_SIGNER_BEARER_TOKEN: "test",
    ROOT_LOG_ID,
  };
  const api = spawn("pnpm", ["--filter", "@canopy/api", "dev"], {
    cwd: process.cwd(),
    stdio: "pipe",
    env: apiEnv,
  });
  children.push(api);
  api.stdout?.on("data", (d) => process.stdout.write(d));
  api.stderr?.on("data", (d) => process.stderr.write(d));

  await waitForPort(CANOPY_API_PORT, "canopy-api");
  // Keep running; Playwright will SIGTERM when done
  await new Promise(() => {});
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
