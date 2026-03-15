#!/usr/bin/env node
/**
 * Generate grant pool for k6 (Plan 0010). For each log ID: mint (POST bootstrap with
 * body { rootLogId }), register-grant (Forestrie-Grant), poll status, resolve receipt,
 * build completed grant; write grant-pool.json with grantBase64 per log and signer hex.
 *
 * Usage:
 *   CANOPY_PERF_BASE_URL=... CANOPY_PERF_API_TOKEN=... CANOPY_PERF_LOG_IDS=uuid1,uuid2,... \
 *   pnpm --filter @canopy/perf run generate-grant-pool
 *
 * Output: perf/k6/canopy-api/data/grant-pool.json
 */

import { mkdirSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { decode as decodeCbor } from "cbor-x";
import {
  buildCompletedGrant,
  extractEntryIdFromReceiptUrl,
  signerHexFromGrantPayload,
} from "../lib/grant-completion.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const BASE_URL = process.env.CANOPY_PERF_BASE_URL?.replace(/\/$/, "");
const API_TOKEN = process.env.CANOPY_PERF_API_TOKEN;
const LOG_IDS_RAW = process.env.CANOPY_PERF_LOG_IDS;
const POLL_MAX = parseInt(process.env.POLL_MAX ?? "120", 10);
const POLL_INTERVAL_MS = parseInt(process.env.POLL_INTERVAL_MS ?? "500", 10);

if (!BASE_URL || !API_TOKEN || !LOG_IDS_RAW) {
  console.error(
    "Required: CANOPY_PERF_BASE_URL, CANOPY_PERF_API_TOKEN, CANOPY_PERF_LOG_IDS",
  );
  process.exit(1);
}

const LOG_IDS = LOG_IDS_RAW.split(",")
  .map((s) => s.trim())
  .filter(Boolean);
if (LOG_IDS.length === 0) {
  console.error(
    "CANOPY_PERF_LOG_IDS must be a non-empty comma-separated list of log IDs (UUID or 64 hex)",
  );
  process.exit(1);
}

const headers: Record<string, string> = {
  Authorization: `Bearer ${API_TOKEN}`,
};

async function pollUntilReceipt(statusUrl: string): Promise<string> {
  for (let i = 0; i < POLL_MAX; i++) {
    const res = await fetch(statusUrl, { redirect: "manual", headers });
    if (res.status === 303) {
      const location = res.headers.get("Location");
      if (location?.endsWith("/receipt")) {
        return location.startsWith("http")
          ? location
          : `${new URL(statusUrl).origin}${location.startsWith("/") ? location : `/${location}`}`;
      }
    }
    if (res.status >= 400) {
      throw new Error(`Poll ${i + 1}: ${res.status} ${await res.text()}`);
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  throw new Error("Timeout waiting for receipt URL");
}

const grants: { logId: string; grantBase64: string }[] = [];
let signerHex: string | null = null;

for (const logId of LOG_IDS) {
  console.error(`Processing log ${logId}...`);

  const mintRes = await fetch(`${BASE_URL}/api/grants/bootstrap`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ rootLogId: logId }),
  });
  if (!mintRes.ok) {
    const text = await mintRes.text();
    console.error(`Mint failed for ${logId}: ${mintRes.status} ${text}`);
    process.exit(1);
  }
  const grantBase64 = (await mintRes.text()).trim();

  const registerRes = await fetch(`${BASE_URL}/logs/${logId}/grants`, {
    method: "POST",
    headers: {
      Authorization: `Forestrie-Grant ${grantBase64}`,
    },
    redirect: "manual",
  });
  if (registerRes.status !== 303) {
    const text = await registerRes.text();
    console.error(`Register failed for ${logId}: ${registerRes.status} ${text}`);
    process.exit(1);
  }
  const statusUrl =
    registerRes.headers.get("Location")?.startsWith("http") ?
      registerRes.headers.get("Location")!
    : `${BASE_URL}${registerRes.headers.get("Location")!.startsWith("/") ? "" : "/"}${registerRes.headers.get("Location")!}`;

  const receiptUrl = await pollUntilReceipt(statusUrl);

  const receiptRes = await fetch(receiptUrl, { headers });
  if (!receiptRes.ok) {
    console.error(`Receipt GET failed for ${logId}: ${receiptRes.status}`);
    process.exit(1);
  }
  const receiptBytes = new Uint8Array(await receiptRes.arrayBuffer());

  const completedBase64 = buildCompletedGrant(grantBase64, receiptUrl, receiptBytes);

  if (!signerHex) {
    const grantBytes = Uint8Array.from(
      atob(grantBase64.replace(/-/g, "+").replace(/_/g, "/")),
      (c) => c.charCodeAt(0),
    );
    const cose = decodeCbor(grantBytes) as unknown[];
    const payload = (cose as [unknown, unknown, Uint8Array, unknown])[2];
    signerHex = signerHexFromGrantPayload(payload);
  }

  grants.push({ logId, grantBase64: completedBase64 });
}

const outDir = join(__dirname, "..", "k6", "canopy-api", "data");
mkdirSync(outDir, { recursive: true });
const outPath = join(outDir, "grant-pool.json");
const payload = {
  signer: signerHex!,
  grants,
};
writeFileSync(outPath, JSON.stringify(payload, null, 2));
console.log(`Wrote ${outPath} (${grants.length} grants)`);
