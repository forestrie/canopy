#!/usr/bin/env node
/**
 * Self-create a SCITT receipt from local log content — no API call.
 *
 * Local mode (sealer-signed receipt): rebuild the inclusion path from the
 * massif blob and attach it to the checkpoint's pre-signed peak receipt. The
 * output is verify-equivalent with an API-issued receipt and passes
 * verify-grant-receipt unchanged (FOR-334 AC: verify-equivalence, not
 * byte-equality).
 *
 * Chain-anchored mode: fetch the accumulator published by the Univocity
 * contract (`logState(bytes32)`), rebuild the inclusion path at the on-chain
 * tree size, and check the computed peak against the on-chain accumulator.
 * The only network access is the single eth_call; nothing is sent to the
 * transparency service.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import {
  buildReceiptOffline,
  computeAccumulatorPeak,
  parseCheckpoint,
} from "@forestrie/receipt-verify";

// keccak256("logState(bytes32)")[0:4] — `cast sig "logState(bytes32)"`.
const LOG_STATE_SELECTOR = "eecac1b7";
const DEFAULT_RPC_URL = "https://sepolia.base.org";

const USAGE = `Usage:
  Local (sealer-signed receipt from massif + checkpoint):
    create-receipt --massif PATH.log --checkpoint PATH.sth --mmr-index N --out receipt.cbor

  Chain-anchored (verify local content against the Univocity accumulator):
    create-receipt --massif PATH.log --mmr-index N \\
      --univocity 0xADDRESS --log-id UUID [--rpc-url URL]

  Modes combine when both --checkpoint and --univocity are given.`;

const { values } = parseArgs({
  options: {
    massif: { type: "string" },
    checkpoint: { type: "string" },
    "mmr-index": { type: "string" },
    out: { type: "string" },
    univocity: { type: "string" },
    "log-id": { type: "string" },
    "rpc-url": { type: "string" },
  },
});

function fail(message: string, code = 2): never {
  console.error(message);
  process.exit(code);
}

function readBytes(path: string): Uint8Array {
  return new Uint8Array(readFileSync(path));
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (clean.length % 2 !== 0 || /[^0-9a-fA-F]/.test(clean)) {
    throw new Error(`invalid hex: ${hex.slice(0, 20)}…`);
  }
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/**
 * Contract logId is bytes32: either a log UUID right-aligned in 32 bytes, or
 * a raw 32-byte hex id (e.g. an authority log keyed by a keccak hash).
 */
function logIdToBytes32Hex(logId: string): string {
  const hex = logId.replace(/^0x/, "").replace(/-/g, "").toLowerCase();
  if (/^[0-9a-f]{64}$/.test(hex)) {
    return hex;
  }
  if (/^[0-9a-f]{32}$/.test(hex)) {
    return "0".repeat(32) + hex;
  }
  throw new Error(`--log-id must be a UUID or 32-byte hex, got: ${logId}`);
}

function word(data: Uint8Array, offset: number): bigint {
  if (offset + 32 > data.length) {
    throw new Error("eth_call return data truncated");
  }
  return BigInt("0x" + bytesToHex(data.subarray(offset, offset + 32)));
}

/** Decode `returns (LogState)` = tuple(bytes32[] accumulator, uint64 size). */
function decodeLogState(returnData: Uint8Array): {
  accumulator: Uint8Array[];
  size: bigint;
} {
  const structOffset = Number(word(returnData, 0));
  const accumulatorRel = Number(word(returnData, structOffset));
  const size = word(returnData, structOffset + 32);
  const arrayStart = structOffset + accumulatorRel;
  const length = Number(word(returnData, arrayStart));
  const accumulator: Uint8Array[] = [];
  for (let i = 0; i < length; i++) {
    const off = arrayStart + 32 + i * 32;
    if (off + 32 > returnData.length) {
      throw new Error("eth_call return data truncated (accumulator)");
    }
    accumulator.push(returnData.slice(off, off + 32));
  }
  return { accumulator, size };
}

async function fetchLogState(
  rpcUrl: string,
  univocityAddress: string,
  logId: string,
): Promise<{ accumulator: Uint8Array[]; size: bigint }> {
  if (!/^0x[0-9a-fA-F]{40}$/.test(univocityAddress)) {
    fail(`--univocity must be a 20-byte hex address, got: ${univocityAddress}`);
  }
  const callData = "0x" + LOG_STATE_SELECTOR + logIdToBytes32Hex(logId);
  const response = await fetch(rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "eth_call",
      params: [{ to: univocityAddress, data: callData }, "latest"],
    }),
  });
  if (!response.ok) {
    throw new Error(`rpc http ${response.status} from ${rpcUrl}`);
  }
  const body = (await response.json()) as {
    result?: string;
    error?: { message?: string };
  };
  if (body.error) {
    throw new Error(`eth_call failed: ${body.error.message ?? "unknown"}`);
  }
  if (!body.result || body.result === "0x") {
    throw new Error(
      "eth_call returned no data — wrong contract address or chain?",
    );
  }
  return decodeLogState(hexToBytes(body.result));
}

async function main(): Promise<void> {
  const massifPath = values.massif;
  const mmrIndexRaw = values["mmr-index"];
  if (!massifPath || !mmrIndexRaw) {
    fail(USAGE);
  }
  if (!/^[0-9]+$/.test(mmrIndexRaw)) {
    fail("--mmr-index must be a non-negative integer");
  }
  const mmrIndex = BigInt(mmrIndexRaw);
  const massifBytes = readBytes(massifPath);

  const checkpointPath = values.checkpoint;
  const univocityAddress = values.univocity;
  if (!checkpointPath && !univocityAddress) {
    fail(USAGE);
  }

  let failed = false;

  if (checkpointPath) {
    const outPath = values.out;
    if (!outPath) {
      fail("--checkpoint requires --out PATH for the assembled receipt");
    }
    const checkpointBytes = readBytes(checkpointPath);
    const receiptCbor = buildReceiptOffline({
      massifBytes,
      checkpointBytes,
      mmrIndex,
    });
    writeFileSync(outPath, receiptCbor);
    const sealedSize = parseCheckpoint(checkpointBytes).mmrSize;
    console.log(
      `local: wrote ${outPath} (${receiptCbor.length} bytes, sealed size ${sealedSize})`,
    );
  }

  if (univocityAddress) {
    const logId = values["log-id"];
    if (!logId) {
      fail("--univocity requires --log-id UUID");
    }
    const rpcUrl = values["rpc-url"] ?? DEFAULT_RPC_URL;
    const { accumulator, size } = await fetchLogState(
      rpcUrl,
      univocityAddress,
      logId,
    );
    if (size === 0n || accumulator.length === 0) {
      fail(`chain: log ${logId} has no on-chain checkpoint yet`, 1);
    }
    if (mmrIndex >= size) {
      fail(
        `chain: entry mmrIndex ${mmrIndex} not anchored yet (on-chain size ${size})`,
        1,
      );
    }
    const computed = await computeAccumulatorPeak({
      massifBytes,
      mmrIndex,
      mmrSize: size,
    });
    const onchainPeak = accumulator[computed.peakIndex];
    const matches =
      onchainPeak !== undefined &&
      bytesToHex(computed.peak) === bytesToHex(onchainPeak);
    if (matches) {
      console.log(
        `chain-anchored: ok — computed peak ${computed.peakIndex + 1}/${accumulator.length} ` +
          `matches on-chain accumulator at size ${size}`,
      );
    } else {
      console.error(
        `chain-anchored: MISMATCH — computed ${bytesToHex(computed.peak)}, ` +
          `on-chain ${onchainPeak ? bytesToHex(onchainPeak) : "<missing peak>"} ` +
          `(peak index ${computed.peakIndex}, size ${size})`,
      );
      failed = true;
    }
  }

  if (failed) {
    process.exit(1);
  }
  console.log("ok");
}

main().catch((err) => {
  console.error(String(err));
  process.exit(1);
});
