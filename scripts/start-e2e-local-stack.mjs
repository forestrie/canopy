#!/usr/bin/env node
/**
 * Start univocity stub, delegation-signer (test key), and canopy-api for e2e local tests.
 * Used by Playwright webServer (default local project) so bootstrap + register-grant can run.
 * Waits for ports then keeps running until SIGTERM; kills children on exit.
 */

import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");

const UNIVOCITY_STUB_PORT = Number(
  process.env.E2E_UNIVOCITY_STUB_PORT ?? "8792",
);
const DELEGATION_SIGNER_PORT = 8791;
const CANOPY_API_PORT = 8789;
const ROOT_LOG_ID = "123e4567e89b12d3a456426614174000";

async function waitForHttp(
  url,
  predicate,
  label,
  maxWaitMs = 30_000,
  intervalMs = 400,
) {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    try {
      const r = await fetch(url);
      if (await Promise.resolve(predicate(r))) return;
    } catch (_) {}
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`${label} did not become ready (${url})`);
}

async function main() {
  const children = [];

  const killChildren = () => {
    for (const c of [...children].reverse()) {
      try {
        c.kill("SIGTERM");
      } catch (_) {}
    }
    process.exit(0);
  };
  process.on("SIGTERM", killChildren);
  process.on("SIGINT", killChildren);

  const fs = await import("node:fs");

  const stub = spawn(
    process.execPath,
    [resolve(repoRoot, "scripts/e2e-univocity-stub.mjs")],
    {
      cwd: repoRoot,
      stdio: "pipe",
      env: {
        ...process.env,
        E2E_UNIVOCITY_STUB_PORT: String(UNIVOCITY_STUB_PORT),
      },
    },
  );
  children.push(stub);
  stub.stdout?.on("data", (d) => process.stdout.write(d));
  stub.stderr?.on("data", (d) => process.stderr.write(d));

  await waitForHttp(
    `http://127.0.0.1:${UNIVOCITY_STUB_PORT}/api/logs/00000000-0000-0000-0000-000000000000/config`,
    (r) => r.status === 404,
    "univocity stub",
    15_000,
  );

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
    cwd: repoRoot,
    stdio: "pipe",
    env: { ...process.env },
  });
  children.push(ds);
  ds.stdout?.on("data", (d) => process.stdout.write(d));
  ds.stderr?.on("data", (d) => process.stderr.write(d));

  await waitForHttp(
    `http://127.0.0.1:${DELEGATION_SIGNER_PORT}/api/health`,
    (r) => r.ok,
    "delegation-signer",
  );

  const apiEnv = {
    ...process.env,
    DELEGATION_SIGNER_URL: `http://127.0.0.1:${DELEGATION_SIGNER_PORT}`,
    DELEGATION_SIGNER_BEARER_TOKEN: "test",
    ROOT_LOG_ID,
  };
  const stubUrl = `http://127.0.0.1:${UNIVOCITY_STUB_PORT}`;
  const api = spawn(
    "pnpm",
    [
      "--filter",
      "@canopy/api",
      "exec",
      "wrangler",
      "dev",
      "--var",
      `UNIVOCITY_SERVICE_URL:${stubUrl}`,
    ],
    {
      cwd: repoRoot,
      stdio: "pipe",
      env: apiEnv,
    },
  );
  children.push(api);
  api.stdout?.on("data", (d) => process.stdout.write(d));
  api.stderr?.on("data", (d) => process.stderr.write(d));

  await waitForHttp(
    `http://127.0.0.1:${CANOPY_API_PORT}/api/health`,
    async (r) => {
      if (!r.ok) return false;
      try {
        const j = await r.json();
        return j?.status === "healthy";
      } catch {
        return false;
      }
    },
    "canopy-api",
  );

  console.error(
    "[start-e2e-local-stack] ready: stub, delegation-signer, canopy-api",
  );
  await new Promise(() => {});
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
