/**
 * Nightly metering canary (plan-2607-06 / FOR-479): an ACTIVE liveness probe
 * of the whole metering pipeline on the target lane — pay → unfreeze →
 * register → seal → publish → chain → indexer → accrual. Deliberately not
 * the integrity test (that is the ADR-0058 §7 reconciliation job, FOR-496):
 * reconciliation cannot detect a silent pipeline, and on a traffic-less lane
 * this canary is the only traffic.
 *
 * Runs against a PINNED canary instance whose sealing is pre-delegated to
 * the standing sealer key and whose self-referential root grant is reusable.
 * Enforcement is armed on the lane, so each run tops up prepaid credits when
 * the balance runs low — the top-up is not incidental: it keeps the pinned
 * account unfrozen AND exercises the x402 revenue loop end to end.
 *
 * The x402 challenge is signed by spawning the sibling
 * `gen-x402-payment-signature.mjs` (the known-working EIP-3009 signer the
 * e2e kit itself was ported from) — no build step needed.
 *
 * Env (see .github/workflows/metering-canary.yml):
 *   FORESTRIE_BASE_URL        canopy-api origin (lane)
 *   X402_SETTLEMENT_URL       x402-settlement origin (admin routes)
 *   CANOPY_OPS_ADMIN_TOKEN    ops bearer for /admin/*
 *   CANOPY_X402_DEV_PRIVATE_KEY or DEPLOY_KEY   funded Base Sepolia payer
 *   CANARY_INSTANCE_ID        canonical univocityInstanceId (CAIP-10)
 *   CANARY_LOG_ID             root log UUID
 *   CANARY_GRANT_B64          completed self-referential root grant
 *   CANARY_LOG_PEM            ES256 private key PEM for the canary log
 *   DELEGATION_COORDINATOR_URL  coordinator origin for `forestrie delegate`
 *   KNOWN_SEALER_KEY          registrar voucher-signing key, base64 x||y
 *   CANARY_DELEGATE_TTL_SECONDS  advance-delegation TTL (default 129600 = 36 h)
 *   FORESTRIE_VERSION         CLI release tag (default v0.6.0)
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPTS_DIR = dirname(fileURLToPath(import.meta.url));

const POLL_BUDGET_MS = 15 * 60 * 1000;
const POLL_INTERVAL_MS = 60 * 1000;
const SETTLE_BUDGET_MS = 4 * 60 * 1000;
const SETTLE_INTERVAL_MS = 10 * 1000;
const TOP_UP_BELOW = 5;
const TOP_UP_CREDITS = 10;

function env(name, fallback) {
  const v = process.env[name]?.trim();
  if (v) return v;
  if (fallback !== undefined) return fallback;
  console.error(`canary: missing required env ${name}`);
  process.exit(2);
}

const BASE = env("FORESTRIE_BASE_URL");
const SETTLEMENT = env("X402_SETTLEMENT_URL");
const OPS = env("CANOPY_OPS_ADMIN_TOKEN");
const PAYER_KEY =
  process.env.CANOPY_X402_DEV_PRIVATE_KEY?.trim() ||
  process.env.DEPLOY_KEY?.trim();
const INSTANCE_ID = env("CANARY_INSTANCE_ID");
const LOG_ID = env("CANARY_LOG_ID");
const GRANT_B64 = env("CANARY_GRANT_B64");
const LOG_PEM = env("CANARY_LOG_PEM");
const COORDINATOR_URL = env("DELEGATION_COORDINATOR_URL");
const SEALER_VOUCHER_KEY = env("KNOWN_SEALER_KEY");
const DELEGATE_TTL_SECONDS = env("CANARY_DELEGATE_TTL_SECONDS", "129600");
const CLI_VERSION = env("FORESTRIE_VERSION", "v0.6.0");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function readReceivables() {
  const res = await fetch(
    `${SETTLEMENT}/admin/receivables/${encodeURIComponent(INSTANCE_ID)}`,
    { headers: { Authorization: `Bearer ${OPS}` } },
  );
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`receivables read failed: ${res.status}`);
  return res.json();
}

let sweepUnavailable = false;

/**
 * Best-effort sweep nudge: a missing or failing /admin/sweep degrades the
 * canary to the indexer's 5-minute cron cadence instead of failing it — the
 * route is an accelerator, not a dependency (and may lag a deploy).
 */
async function sweep() {
  if (sweepUnavailable) return null;
  const res = await fetch(`${SETTLEMENT}/admin/sweep`, {
    method: "POST",
    headers: { Authorization: `Bearer ${OPS}` },
  });
  if (!res.ok) {
    sweepUnavailable = true;
    console.warn(
      `canary: /admin/sweep unavailable (${res.status}); relying on the indexer cron`,
    );
    return null;
  }
  return res.json();
}

async function purchaseCredits(credits) {
  if (!PAYER_KEY) {
    throw new Error(
      "top-up needed but no payer key (CANOPY_X402_DEV_PRIVATE_KEY or DEPLOY_KEY)",
    );
  }
  const url = `${BASE}/api/payments/credits/${encodeURIComponent(INSTANCE_ID)}?credits=${credits}`;
  const challenge = await fetch(url, { method: "POST" });
  if (challenge.status !== 402) {
    throw new Error(
      `credits challenge: expected 402, got ${challenge.status}: ${(await challenge.text()).slice(0, 200)}`,
    );
  }
  const required = challenge.headers.get("x-payment-required");
  if (!required) throw new Error("credits challenge lacks X-PAYMENT-REQUIRED");
  const xPayment = execFileSync(
    process.execPath,
    [
      join(SCRIPTS_DIR, "gen-x402-payment-signature.mjs"),
      "--payment-required",
      required,
    ],
    {
      encoding: "utf8",
      env: { ...process.env, CANOPY_X402_DEV_PRIVATE_KEY: PAYER_KEY },
    },
  ).trim();
  const paid = await fetch(url, {
    method: "POST",
    headers: { "X-PAYMENT": xPayment },
  });
  if (paid.status !== 202) {
    throw new Error(
      `credits purchase: expected 202, got ${paid.status}: ${(await paid.text()).slice(0, 200)}`,
    );
  }
  console.log(`canary: purchased ${credits} credits (202 accepted)`);
}

/** Pinned-release CLI fetch, sha256-verified (the demo preflight pattern). */
async function fetchCli(dir) {
  const { platform, arch } = process;
  const asset =
    platform === "linux" && arch === "x64"
      ? "forestrie-linux-x64"
      : platform === "darwin" && arch === "arm64"
        ? "forestrie-darwin-arm64"
        : null;
  if (!asset) throw new Error(`no CLI release asset for ${platform}/${arch}`);
  const base = `https://github.com/forestrie/forestrie-cli/releases/download/${CLI_VERSION}`;
  const bin = await (await fetch(`${base}/${asset}`)).arrayBuffer();
  const want = (await (await fetch(`${base}/${asset}.sha256`)).text()).split(
    /\s+/,
  )[0];
  const got = createHash("sha256").update(Buffer.from(bin)).digest("hex");
  if (!want || want !== got) {
    throw new Error(`CLI sha256 mismatch (want ${want}, got ${got})`);
  }
  const path = join(dir, "forestrie");
  writeFileSync(path, Buffer.from(bin));
  chmodSync(path, 0o755);
  console.log(`canary: fetched forestrie ${CLI_VERSION} (${asset})`);
  return path;
}

function run(cmd, args) {
  return execFileSync(cmd, args, { encoding: "utf8" });
}

async function main() {
  const work = mkdtempSync(join(tmpdir(), "metering-canary-"));
  const pemPath = join(work, "canary.es256.pem");
  writeFileSync(pemPath, LOG_PEM.endsWith("\n") ? LOG_PEM : `${LOG_PEM}\n`);

  // 1. Baseline.
  const before = (await readReceivables()) ?? {
    entitlement: null,
    watermarkBlock: null,
  };
  const accruedBefore = before.entitlement?.checkpointsAccrued ?? 0;
  const balanceBefore = before.entitlement?.creditsBalance ?? 0;
  console.log(
    `canary: baseline accrued=${accruedBefore} balance=${balanceBefore} frozen=${before.entitlement?.enforcementFrozen ?? false}`,
  );

  // 2. Top up when low; wait for settlement, then sweep so the kill switch
  //    reconciles (unfreeze) before we try to register.
  if (balanceBefore < TOP_UP_BELOW) {
    await purchaseCredits(TOP_UP_CREDITS);
    const target = balanceBefore + TOP_UP_CREDITS;
    const deadline = Date.now() + SETTLE_BUDGET_MS;
    let settled = false;
    while (Date.now() < deadline) {
      await sleep(SETTLE_INTERVAL_MS);
      const state = await readReceivables();
      if ((state?.entitlement?.creditsBalance ?? 0) >= target) {
        settled = true;
        break;
      }
    }
    if (!settled) throw new Error("credits settlement did not land in budget");
    // Unfreeze happens when a sweep reconciles the kill switch — forced via
    // /admin/sweep where available, else within one indexer cron tick.
    const unfreezeDeadline = Date.now() + 7 * 60 * 1000;
    let state = await readReceivables();
    while (state?.entitlement?.enforcementFrozen) {
      if (Date.now() > unfreezeDeadline) {
        throw new Error("account still frozen after top-up (unfreeze budget)");
      }
      await sweep();
      await sleep(SETTLE_INTERVAL_MS);
      state = await readReceivables();
    }
    console.log(
      `canary: topped up; balance=${state?.entitlement?.creditsBalance} unfrozen`,
    );
  }

  // 3. Refresh the advance delegation. Delegations are finite leases (the
  //    default TTL is the coordinator's suggestedTtlSeconds, 6 h) — the
  //    one-shot bring-up pre-delegation expired on 2026-07-28 and every seal
  //    after it sat as a pending demand nothing could sign (the root PEM
  //    lives only here). Minting per run makes the canary self-healing and
  //    exercises the delegate-in-advance surface nightly; 36 h bridges a
  //    skipped night.
  const cli = await fetchCli(work);
  run(cli, [
    "delegate",
    "--coordinator-url",
    COORDINATOR_URL,
    "--log-id",
    LOG_ID,
    "--sign-with",
    pemPath,
    "--known-sealer-key",
    SEALER_VOUCHER_KEY,
    "--ttl-seconds",
    DELEGATE_TTL_SECONDS,
  ]);
  console.log(
    `canary: advance delegation refreshed (ttl=${DELEGATE_TTL_SECONDS}s)`,
  );

  // 4. Register a fresh statement through the CLI (publish liveness: with
  //    sealing delegated the receipt path completes in seconds).
  const stmtJson = join(work, "statement.json");
  const stmtCose = join(work, "statement.cose");
  writeFileSync(
    stmtJson,
    JSON.stringify({ canary: "plan-2607-06", runAt: new Date().toISOString() }),
  );
  run(cli, [
    "sign-statement",
    "--key",
    pemPath,
    "--payload",
    stmtJson,
    "--content-type",
    "application/json",
    "--out",
    stmtCose,
  ]);
  const regOut = run(cli, [
    "register",
    "--base-url",
    BASE,
    "--log-id",
    LOG_ID,
    "--grant-b64",
    GRANT_B64,
    "--statement",
    stmtCose,
  ]);
  if (!/receipt/i.test(regOut)) {
    throw new Error(`register output lacks a receipt reference:\n${regOut}`);
  }
  console.log("canary: statement registered, receipt returned");

  // 5. Poll for accrual: sweep + read until the checkpoint lands. Safe-head
  //    lag (~6 min on Base Sepolia) dominates; the sweep removes the cron
  //    wait, not the chain wait.
  const deadline = Date.now() + POLL_BUDGET_MS;
  let last = before;
  while (Date.now() < deadline) {
    await sweep();
    last = (await readReceivables()) ?? last;
    const accrued = last?.entitlement?.checkpointsAccrued ?? 0;
    if (accrued > accruedBefore) {
      const balance = last.entitlement.creditsBalance;
      console.log(
        `canary: PASS accrued ${accruedBefore}→${accrued} balance=${balance} watermark=${last.watermarkBlock}`,
      );
      return;
    }
    console.log(
      `canary: waiting… accrued=${accrued} watermark=${last?.watermarkBlock ?? "-"}`,
    );
    await sleep(POLL_INTERVAL_MS);
  }
  throw new Error(
    `metering canary FAILED: no accrual within ${POLL_BUDGET_MS / 60000} min ` +
      `(accrued still ${accruedBefore}) — sealer/publisher/indexer pipeline suspect`,
  );
}

main().catch((err) => {
  console.error(String(err?.stack ?? err));
  process.exit(1);
});
