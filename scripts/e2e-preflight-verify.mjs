#!/usr/bin/env node
/**
 * Verify external services required for e2e (after stack is up, or for remote-only runs).
 *
 * Usage:
 *   node scripts/e2e-preflight-verify.mjs local
 *   node scripts/e2e-preflight-verify.mjs remote
 *
 * Env (local defaults match start-e2e-local-stack.mjs):
 *   E2E_CANOPY_BASE_URL        default http://127.0.0.1:8789
 *   E2E_DELEGATION_SIGNER_URL  default http://127.0.0.1:8791
 *   E2E_UNIVOCITY_STUB_URL     default http://127.0.0.1:8792
 *   CANOPY_E2E_BASE_URL        used for remote mode
 */

const mode = process.argv[2] ?? "local";

function fail(msg) {
  console.error(`[e2e-preflight-verify] FAIL: ${msg}`);
  process.exit(1);
}

async function getJson(url) {
  const r = await fetch(url, { headers: { Accept: "application/json" } });
  const text = await r.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: r.status, body, text };
}

async function verifyLocal() {
  const canopy = (
    process.env.E2E_CANOPY_BASE_URL ?? "http://127.0.0.1:8789"
  ).replace(/\/$/, "");
  const signer = (
    process.env.E2E_DELEGATION_SIGNER_URL ?? "http://127.0.0.1:8791"
  ).replace(/\/$/, "");
  const stub = (
    process.env.E2E_UNIVOCITY_STUB_URL ?? "http://127.0.0.1:8792"
  ).replace(/\/$/, "");

  const health = await getJson(`${canopy}/api/health`);
  if (health.status !== 200 || health.body?.status !== "healthy") {
    fail(
      `canopy-api ${canopy}/api/health expected 200 + status healthy, got ${health.status} ${health.text.slice(0, 200)}`,
    );
  }
  console.error(`[e2e-preflight-verify] OK canopy-api health (${canopy})`);

  const ds = await getJson(`${signer}/api/health`);
  if (ds.status !== 200) {
    fail(
      `delegation-signer ${signer}/api/health expected 200, got ${ds.status}`,
    );
  }
  console.error(`[e2e-preflight-verify] OK delegation-signer health (${signer})`);

  const cfg = await getJson(
    `${stub}/api/logs/00000000-0000-0000-0000-000000000000/config`,
  );
  if (cfg.status !== 404) {
    fail(
      `univocity stub ${stub}/api/logs/.../config expected 404 (uninitialized), got ${cfg.status}`,
    );
  }
  console.error(`[e2e-preflight-verify] OK univocity stub (${stub})`);

  const logId = "123e4567-e89b-12d3-a456-426614174000";
  const mint = await fetch(`${canopy}/api/grants/bootstrap`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ rootLogId: logId }),
  });
  if (mint.status !== 201) {
    const t = await mint.text();
    fail(
      `bootstrap mint expected 201, got ${mint.status}: ${t.slice(0, 300)}`,
    );
  }
  console.error("[e2e-preflight-verify] OK POST /api/grants/bootstrap (201)");
}

async function verifyRemote() {
  const base = (process.env.CANOPY_E2E_BASE_URL ?? "").replace(/\/$/, "");
  if (!base) {
    fail("remote mode requires CANOPY_E2E_BASE_URL");
  }

  const health = await getJson(`${base}/api/health`);
  if (health.status !== 200 || health.body?.status !== "healthy") {
    fail(
      `remote ${base}/api/health expected 200 + healthy, got ${health.status}`,
    );
  }
  console.error(`[e2e-preflight-verify] OK remote health (${base})`);

  const logId = "123e4567-e89b-12d3-a456-426614174000";
  const mint = await fetch(`${base}/api/grants/bootstrap`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ rootLogId: logId }),
  });
  if (mint.status === 404 || mint.status === 503) {
    fail(
      `remote bootstrap not available (${mint.status}). Deploy worker with POST /api/grants/bootstrap and DELEGATION_SIGNER_*`,
    );
  }
  if (mint.status !== 201) {
    const t = await mint.text();
    fail(`remote bootstrap expected 201, got ${mint.status}: ${t.slice(0, 200)}`);
  }
  console.error("[e2e-preflight-verify] OK remote bootstrap mint (201)");
}

async function main() {
  if (mode === "remote") {
    await verifyRemote();
  } else {
    await verifyLocal();
  }
  console.error("[e2e-preflight-verify] all checks passed");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
