#!/usr/bin/env node
/**
 * GET receipt URL, build completed transparent statement (grant + idtimestamp + receipt), write base64.
 * Usage: SCRAPI_API_KEY=... tsx resolve-receipt-to-grant.ts <receiptUrl> <originalGrantPath> <outputPath>
 * - receiptUrl: full URL to GET (e.g. .../entries/{entryId}/receipt)
 * - originalGrantPath: file with base64 transparent statement (bootstrap grant)
 * - outputPath: write completed statement base64 here
 */

import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { dirname } from "path";
import { buildCompletedGrant } from "../lib/grant-completion.js";

const args = process.argv.slice(2).filter((a) => a !== "--");
const receiptUrl = args[0];
const originalGrantPath = args[1];
const outputPath = args[2];

const apiToken = process.env.SCRAPI_API_KEY?.trim();

if (!receiptUrl || !originalGrantPath || !outputPath) {
  console.error("Usage: resolve-receipt-to-grant.ts <receiptUrl> <originalGrantPath> <outputPath>");
  process.exit(1);
}

if (!apiToken) {
  console.error("SCRAPI_API_KEY is required");
  process.exit(1);
}

async function main() {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${apiToken}`,
  };

  const res = await fetch(receiptUrl, { headers });
  if (!res.ok) {
    console.error(`GET ${receiptUrl}: ${res.status} ${await res.text()}`);
    process.exit(1);
  }
  const receiptBytes = new Uint8Array(await res.arrayBuffer());

  const grantBase64 = readFileSync(originalGrantPath, "utf8").trim();
  const completedBase64 = buildCompletedGrant(grantBase64, receiptUrl, receiptBytes);

  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, completedBase64, "utf8");
  console.log(`Wrote ${outputPath}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
