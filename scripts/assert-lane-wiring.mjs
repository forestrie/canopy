#!/usr/bin/env node
/**
 * CI guard for FOR-443: the x402 producer and consumer must resolve to the same
 * names on every lane.
 *
 * canopy-api PRODUCES settlement jobs; x402-settlement CONSUMES them. They live
 * in different packages with different wrangler configs. Before plan-2607-39
 * they agreed only by hand-matched literals plus a CANOPY_ID derivation that
 * nothing verified -- so Lane B silently deployed bound to Lane A's queue and
 * Durable Object, and Lane A's settlement worker processed Lane B's payments.
 *
 * This runs BOTH runtime contract scripts over the real checked-in wrangler
 * configs, with the per-lane values forest-1 publishes, and asserts the two
 * sides agree. It is a plain node script rather than a vitest test because the
 * canopy vitest projects run under workerd, which has no node:child_process.
 *
 * Usage: node scripts/assert-lane-wiring.mjs
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const API_DIR = join(REPO_ROOT, "packages/apps/canopy-api");
const SETTLEMENT_DIR = join(REPO_ROOT, "packages/apps/x402-settlement");

/**
 * Per-lane contract fixtures. These mirror what forest-1's
 * `canopy:publish-contract:*` writes to `{PROJECT_ID}/canopy_{lane}`. Only the
 * x402 keys are load-bearing here; the rest satisfy canopy-api's required-var
 * checks so the script runs to completion.
 */
const LANES = [
  {
    lane: "A",
    wranglerEnv: "dev",
    contract: {
      CANOPY_ID: "canopy-dev-1",
      X402_SETTLEMENT_QUEUE_NAME: "canopy-dev-1-x402-settlement",
      X402_SETTLEMENT_SCRIPT_NAME: "x402-settlement-dev",
      R2_MMRS_BUCKET_NAME: "forest-dev-5-logs",
      R2_GRANTS_BUCKET_NAME: "forest-dev-5-grants",
      SEQUENCING_QUEUE_SCRIPT_NAME: "forestrie-ingress-forest-2-a",
      CANOPY_FQDN: "api-a.forest-2.forestrie.dev",
      FOREST_PROJECT_ID: "forest-dev-5",
      CUSTODIAN_URL: "https://custodian.a.forest-2.forestrie.dev/v1",
      DELEGATION_COORDINATOR_URL: "https://coordinator-a.forest-2.forestrie.dev",
      UNIVOCITY_SERVICE_URL: "https://univocity.a.forest-2.forestrie.dev",
    },
  },
  {
    lane: "B",
    wranglerEnv: "prod",
    contract: {
      CANOPY_ID: "canopy-prod-1",
      X402_SETTLEMENT_QUEUE_NAME: "canopy-prod-1-x402-settlement",
      X402_SETTLEMENT_SCRIPT_NAME: "x402-settlement-prod",
      R2_MMRS_BUCKET_NAME: "forest-dev-5-logs-b",
      R2_GRANTS_BUCKET_NAME: "forest-dev-5-grants-b",
      SEQUENCING_QUEUE_SCRIPT_NAME: "forestrie-ingress-forest-2-b",
      CANOPY_FQDN: "api-b.forest-2.forestrie.dev",
      FOREST_PROJECT_ID: "forest-dev-5",
      CUSTODIAN_URL: "https://custodian.b.forest-2.forestrie.dev/v1",
      DELEGATION_COORDINATOR_URL: "https://coordinator-b.forest-2.forestrie.dev",
      UNIVOCITY_SERVICE_URL: "https://univocity.b.forest-2.forestrie.dev",
    },
  },
];

const failures = [];
function check(condition, message) {
  if (!condition) failures.push(message);
}

const workDir = mkdtempSync(join(tmpdir(), "lane-wiring-"));

function applyContract(cwd, wranglerEnv, contract, outName) {
  const out = join(workDir, outName);
  execFileSync(
    process.execPath,
    ["scripts/apply-runtime-contract.mjs", "--env", wranglerEnv, "--out", out],
    { cwd, env: { ...process.env, ...contract }, stdio: "pipe" },
  );
  return readFileSync(out, "utf8");
}

/** Slice out `env.<name>` so top-level defaults cannot satisfy an assertion. */
function envBlock(config, wranglerEnv) {
  const start = config.indexOf(`"${wranglerEnv}"`, config.indexOf('"env"'));
  if (start < 0) throw new Error(`env.${wranglerEnv} not found`);
  return config.slice(start);
}

function match(text, re) {
  return re.exec(text)?.[1] ?? "";
}

try {
  const resolved = LANES.map((l) => ({
    ...l,
    api: applyContract(API_DIR, l.wranglerEnv, l.contract, `api-${l.lane}.jsonc`),
    settlement: applyContract(
      SETTLEMENT_DIR,
      l.wranglerEnv,
      l.contract,
      `settlement-${l.lane}.jsonc`,
    ),
  }));

  for (const r of resolved) {
    const api = envBlock(r.api, r.wranglerEnv);
    const settlement = envBlock(r.settlement, r.wranglerEnv);
    const tag = `lane ${r.lane} (env ${r.wranglerEnv})`;

    const producedQueue = match(
      api,
      /"binding"\s*:\s*"X402_SETTLEMENT_QUEUE"[\s\S]*?"queue"\s*:\s*"([^"]+)"/,
    );
    const consumedQueue = match(
      settlement,
      /"consumers"\s*:\s*\[[\s\S]*?"queue"\s*:\s*"([^"]+)"/,
    );
    check(
      producedQueue === r.contract.X402_SETTLEMENT_QUEUE_NAME,
      `${tag}: canopy-api produces to "${producedQueue}", contract says "${r.contract.X402_SETTLEMENT_QUEUE_NAME}"`,
    );
    check(
      producedQueue === consumedQueue,
      `${tag}: producer queue "${producedQueue}" != consumer queue "${consumedQueue}"`,
    );

    const doScript = match(
      api,
      /"name"\s*:\s*"X402_SETTLEMENT_DO"[\s\S]*?"script_name"\s*:\s*"([^"]+)"/,
    );
    const workerName = match(settlement, /"name"\s*:\s*"([^"]+)"/);
    check(
      doScript === r.contract.X402_SETTLEMENT_SCRIPT_NAME,
      `${tag}: X402_SETTLEMENT_DO targets "${doScript}", contract says "${r.contract.X402_SETTLEMENT_SCRIPT_NAME}"`,
    );
    check(
      doScript === workerName,
      `${tag}: DO binding targets "${doScript}" but the settlement worker deploys as "${workerName}"`,
    );

    // canopy-api builds the 402 challenge, x402-settlement settles it. A chain
    // mismatch fails at settle time, after the payer has consumed their window.
    const apiNetwork = match(api, /"X402_NETWORK"\s*:\s*"([^"]+)"/);
    const settlementNetwork = match(settlement, /"X402_NETWORK"\s*:\s*"([^"]+)"/);
    check(
      apiNetwork !== "" && apiNetwork === settlementNetwork,
      `${tag}: challenge chain "${apiNetwork}" != settlement chain "${settlementNetwork}"`,
    );

    // No production lane exists yet; both lanes settle on Base Sepolia.
    check(
      apiNetwork !== "eip155:8453",
      `${tag}: configured for mainnet (eip155:8453) but no production lane exists`,
    );
  }

  const [a, b] = resolved;
  const queueA = match(
    envBlock(a.api, a.wranglerEnv),
    /"binding"\s*:\s*"X402_SETTLEMENT_QUEUE"[\s\S]*?"queue"\s*:\s*"([^"]+)"/,
  );
  const queueB = match(
    envBlock(b.api, b.wranglerEnv),
    /"binding"\s*:\s*"X402_SETTLEMENT_QUEUE"[\s\S]*?"queue"\s*:\s*"([^"]+)"/,
  );
  check(
    queueA !== queueB,
    `lanes A and B share settlement queue "${queueA}" -- this is the FOR-443 defect`,
  );
} finally {
  rmSync(workDir, { recursive: true, force: true });
}

if (failures.length > 0) {
  console.error("x402 lane wiring check FAILED:");
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log("x402 lane wiring ok (lanes A and B resolve to disjoint, self-consistent settlement pipelines)");
