#!/usr/bin/env node
/**
 * GET receipt URL, build completed transparent statement (grant + idtimestamp + receipt), write base64.
 * Usage: BASE_URL=... API_TOKEN=... tsx resolve-receipt-to-grant.ts <receiptUrl> <originalGrantPath> <outputPath>
 * - receiptUrl: full URL to GET (e.g. .../entries/{entryId}/receipt)
 * - originalGrantPath: file with base64 transparent statement (bootstrap grant)
 * - outputPath: write completed statement base64 here
 */

import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { dirname } from "path";
import { decode as decodeCbor, encode as encodeCbor } from "cbor-x";

const args = process.argv.slice(2).filter((a) => a !== "--");
const receiptUrl = args[0];
const originalGrantPath = args[1];
const outputPath = args[2];

const baseUrl = process.env.CANOPY_PERF_BASE_URL?.replace(/\/$/, "") ?? process.env.BASE_URL?.replace(/\/$/, "");
const apiToken = process.env.CANOPY_PERF_API_TOKEN ?? process.env.API_TOKEN;

const HEADER_IDTIMESTAMP = -65537;
const HEADER_RECEIPT = 396;
const IDTIMESTAMP_BYTES = 8;

if (!receiptUrl || !originalGrantPath || !outputPath) {
  console.error("Usage: resolve-receipt-to-grant.ts <receiptUrl> <originalGrantPath> <outputPath>");
  process.exit(1);
}

function entryIdToIdtimestamp(entryIdHex: string): Uint8Array {
  if (!/^[0-9a-f]{32}$/i.test(entryIdHex)) {
    throw new Error("entryId must be 32 hex chars (16 bytes)");
  }
  const bytes = new Uint8Array(16);
  for (let i = 0; i < 16; i++) {
    bytes[i] = parseInt(entryIdHex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes.slice(0, IDTIMESTAMP_BYTES);
}

function extractEntryIdFromReceiptUrl(url: string): string {
  const path = url.includes("?") ? url.slice(0, url.indexOf("?")) : url;
  const segments = path.split("/");
  const receiptIndex = segments.indexOf("receipt");
  if (receiptIndex < 1) {
    throw new Error("receipt URL must contain .../entries/{entryId}/receipt");
  }
  const entryId = segments[receiptIndex - 1];
  if (!entryId || entryId.length !== 32) {
    throw new Error("entryId segment must be 32 hex chars");
  }
  return entryId;
}

async function main() {
  const headers: Record<string, string> = {};
  if (apiToken) headers["Authorization"] = `Bearer ${apiToken}`;

  const res = await fetch(receiptUrl, { headers });
  if (!res.ok) {
    console.error(`GET ${receiptUrl}: ${res.status} ${await res.text()}`);
    process.exit(1);
  }
  const receiptBytes = new Uint8Array(await res.arrayBuffer());

  const entryIdHex = extractEntryIdFromReceiptUrl(receiptUrl);
  const idtimestamp = entryIdToIdtimestamp(entryIdHex);

  const grantBase64 = readFileSync(originalGrantPath, "utf8").trim();
  const grantBytes = Uint8Array.from(atob(grantBase64.replace(/-/g, "+").replace(/_/g, "/")), (c) =>
    c.charCodeAt(0),
  );
  const cose = decodeCbor(grantBytes) as unknown[];
  if (!Array.isArray(cose) || cose.length !== 4) {
    throw new Error("Original grant must be COSE Sign1 (array of 4)");
  }
  const [protectedHeader, , payload, signature] = cose as [Uint8Array, unknown, Uint8Array, Uint8Array];
  const unprotected = new Map<number, unknown>([
    [HEADER_IDTIMESTAMP, idtimestamp],
    [HEADER_RECEIPT, receiptBytes],
  ]);
  const completed = [protectedHeader, unprotected, payload, signature];
  const completedBytes = new Uint8Array(encodeCbor(completed));
  const completedBase64 = btoa(String.fromCharCode(...completedBytes));

  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, completedBase64, "utf8");
  console.log(`Wrote ${outputPath}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
