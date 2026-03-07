#!/usr/bin/env node
/**
 * Pre-create grants for k6 performance testing (grant-based auth).
 *
 * For each log ID, POSTs to /logs/{logId}/grants with a CBOR grant request,
 * then writes grant-pool.json (signer + grant locations) for k6 to load.
 * All grants share the same signer so k6 can sign COSE with that kid.
 *
 * Usage:
 *   CANOPY_PERF_BASE_URL=... \
 *   CANOPY_PERF_API_TOKEN=... \
 *   CANOPY_PERF_LOG_IDS=uuid1,uuid2,... \
 *   node perf/scripts/generate-grant-pool.mjs
 *
 * Output: perf/k6/canopy-api/data/grant-pool.json
 */

import { randomBytes } from "crypto";
import { writeFileSync, mkdirSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

const BASE_URL = process.env.CANOPY_PERF_BASE_URL?.replace(/\/$/, "");
const API_TOKEN = process.env.CANOPY_PERF_API_TOKEN;
const LOG_IDS_RAW = process.env.CANOPY_PERF_LOG_IDS;

if (!BASE_URL || !API_TOKEN || !LOG_IDS_RAW) {
  console.error("Required: CANOPY_PERF_BASE_URL, CANOPY_PERF_API_TOKEN, CANOPY_PERF_LOG_IDS");
  process.exit(1);
}

const LOG_IDS = LOG_IDS_RAW.split(",").map((s) => s.trim()).filter(Boolean);
if (LOG_IDS.length === 0) {
  console.error("CANOPY_PERF_LOG_IDS must be a non-empty comma-separated list of log UUIDs");
  process.exit(1);
}

/** UUID string -> 16 bytes (big-endian hex). */
function uuidToBytes(uuid) {
  const hex = uuid.replace(/-/g, "");
  if (hex.length !== 32) throw new Error(`Invalid UUID length: ${hex.length}`);
  const bytes = new Uint8Array(16);
  for (let i = 0; i < 16; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

/** Encode CBOR bstr (major type 2); returns Uint8Array (header + bytes). */
function cborBstr(bytes) {
  const len = bytes.length;
  let header;
  if (len < 24) {
    header = new Uint8Array([0x40 + len]);
  } else if (len < 256) {
    header = new Uint8Array([0x58, len]);
  } else {
    header = new Uint8Array([0x59, (len >> 8) & 0xff, len & 0xff]);
  }
  const out = new Uint8Array(header.length + bytes.length);
  out.set(header, 0);
  out.set(bytes, header.length);
  return out;
}

/** Encode grant request as CBOR map: 3=logId, 4=ownerLogId, 5=grantFlags, 8=grantData, 9=signer, 10=kind. */
function encodeGrantRequest(logIdBytes, ownerLogIdBytes, grantFlags, grantData, signer, kindByte) {
  const pairs = [
    [3, logIdBytes],
    [4, ownerLogIdBytes],
    [5, grantFlags],
    [8, grantData],
    [9, signer],
    [10, kindByte],
  ];
  const chunks = [];
  chunks.push(new Uint8Array([0xa6])); // map(6)
  for (const [key, val] of pairs) {
    chunks.push(new Uint8Array([key])); // small int key
    chunks.push(cborBstr(val));
  }
  const total = chunks.reduce((s, c) => s + c.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

// Fixed signer for all grants (32 bytes); k6 will use this as COSE kid
const signer = randomBytes(32);
const ownerLogIdBytes = uuidToBytes(LOG_IDS[0]); // use first log as owner
const grantFlags = new Uint8Array(8);
const grantData = new Uint8Array(0);
const kindByte = new Uint8Array([0]); // attestor

const grants = [];

for (const logId of LOG_IDS) {
  const logIdBytes = uuidToBytes(logId);
  const body = encodeGrantRequest(
    logIdBytes,
    ownerLogIdBytes,
    grantFlags,
    grantData,
    signer,
    kindByte,
  );

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
