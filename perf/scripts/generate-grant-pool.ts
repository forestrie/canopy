#!/usr/bin/env node
/**
 * Pre-create grants for k6 performance testing (grant-based auth).
 *
 * For each log ID, POSTs to /logs/{logId}/grants with a CBOR grant request
 * (using shared @canopy/encoding), then writes grant-pool.json for k6 to load.
 * All grants share the same signer so k6 can sign COSE with that kid.
 *
 * Usage:
 *   CANOPY_PERF_BASE_URL=... \
 *   CANOPY_PERF_API_TOKEN=... \
 *   CANOPY_PERF_LOG_IDS=uuid1,uuid2,... \
 *   pnpm --filter @canopy/perf run generate-grant-pool
 *
 * Output: perf/k6/canopy-api/data/grant-pool.json
 */

import { randomBytes } from "crypto";
import { mkdirSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { encodeGrantRequest } from "@canopy/encoding";

const __dirname = dirname(fileURLToPath(import.meta.url));

const BASE_URL = process.env.CANOPY_PERF_BASE_URL?.replace(/\/$/, "");
const API_TOKEN = process.env.CANOPY_PERF_API_TOKEN;
const LOG_IDS_RAW = process.env.CANOPY_PERF_LOG_IDS;

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
    "CANOPY_PERF_LOG_IDS must be a non-empty comma-separated list of log UUIDs",
  );
  process.exit(1);
}

/** UUID string -> 16 bytes (big-endian hex). */
function uuidToBytes(uuid: string): Uint8Array {
  const hex = uuid.replace(/-/g, "");
  if (hex.length !== 32) throw new Error(`Invalid UUID length: ${hex.length}`);
  const bytes = new Uint8Array(16);
  for (let i = 0; i < 16; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

const signer = new Uint8Array(randomBytes(32));
const ownerLogIdBytes = uuidToBytes(LOG_IDS[0]);
const grantFlags = new Uint8Array(8);
const grantData = new Uint8Array(0);
const kindByte = new Uint8Array([0]); // attestor

const grants: { logId: string; grantLocation: string }[] = [];

for (const logId of LOG_IDS) {
  const logIdBytes = uuidToBytes(logId);
  const body = encodeGrantRequest({
    logId: logIdBytes,
    ownerLogId: ownerLogIdBytes,
    grantFlags,
    grantData,
    signer,
    kind: kindByte,
  });

  const url = `${BASE_URL}/logs/${logId}/grants`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/cbor",
      Authorization: `Bearer ${API_TOKEN}`,
    },
    body,
  });

  if (!res.ok) {
    const text = await res.text();
    console.error(`POST ${url} failed: ${res.status} ${text}`);
    process.exit(1);
  }

  const location = res.headers.get("Location");
  if (!location || !location.startsWith("/")) {
    console.error(`POST ${url} missing or invalid Location header`);
    process.exit(1);
  }
  grants.push({ logId, grantLocation: location });
}

const outDir = join(__dirname, "..", "k6", "canopy-api", "data");
mkdirSync(outDir, { recursive: true });
const outPath = join(outDir, "grant-pool.json");
const payload = {
  signer: Buffer.from(signer).toString("hex"),
  grants,
};
writeFileSync(outPath, JSON.stringify(payload, null, 2));
console.log(`Wrote ${outPath} (${grants.length} grants)`);
