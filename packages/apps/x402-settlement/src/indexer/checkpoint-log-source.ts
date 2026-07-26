/**
 * Pure chain-event source for the accrual indexer (plan-2607-43 slice 03).
 *
 * No Durable Object knowledge lives here — this module is the replaceable
 * half of the build-vs-buy decision recorded in the slice doc: a future
 * purpose-built indexer replaces this file and writes through the same
 * idempotent DO ingestion contract.
 *
 * Decoding is deliberately partial: accrual needs only topic0 + the target
 * log + the static head words (`logKind`, `size`); the trailing dynamic
 * `bytes32[]` arrays (`accumulator`, `grantPath`) are never touched.
 */

import { ethRpcWithFailover } from "@forestrie/chain-rpc";

/**
 * topic0 of `CheckpointPublished(bytes32,bytes32,bytes,address,bytes8,uint8,uint64,bytes32[],uint64,bytes32[])`
 * (univocity `IUnivocityEvents.sol`), chain-verified in
 * canopy `docs/demo/forestrie-demo.md` ("CHECKPOINT_TOPIC").
 */
export const CHECKPOINT_PUBLISHED_TOPIC0 =
  "0x156942b408823cb05a16027962ea485fa7171d99779ee04094280b2569482426";

/** One decoded `CheckpointPublished` occurrence. */
export interface CheckpointLogEvent {
  /** `{txHash}:{logIndex}` — the stable accrual idempotency key. */
  idempotencyKey: string;
  /** Target log id (topics[1], 32-byte hex). */
  logId: string;
  /** Authority (1) vs data (2), event word 2. */
  logKind: number;
  /** Post-checkpoint MMR leaf count, event word 3. */
  size: number;
  blockNumber: number;
}

interface RpcLog {
  transactionHash?: string;
  logIndex?: string;
  blockNumber?: string;
  topics?: string[];
  data?: string;
}

function hexToInt(hex: string | undefined, label: string): number {
  if (!hex || !/^0x[0-9a-fA-F]+$/.test(hex)) {
    throw new Error(`checkpoint log source: ${label} is not hex: ${hex}`);
  }
  const n = Number.parseInt(hex, 16);
  if (!Number.isSafeInteger(n)) {
    throw new Error(`checkpoint log source: ${label} exceeds safe integer`);
  }
  return n;
}

/**
 * Structural invariant of this exact event layout: data word 4 is the head
 * offset of `accumulator`, always 7 words × 32 = 0xe0. topic0 pins the
 * signature but NOT indexed-ness, so a contract revision that re-indexes
 * parameters keeps topic0 while shifting every data word — this tripwire
 * turns that silent corruption into a loud per-account stall, which is
 * recoverable by rescan once the decoder is fixed (a skip would be
 * permanent loss). Residual: an owner can craft a mismatched log to stall
 * their own meter — their own account, remediable by the ops watermark tool
 * (slice-04 arming gate).
 */
const ACCUMULATOR_HEAD_OFFSET = 7 * 32;

/** 0-indexed 32-byte word of the ABI data section, as an integer. */
function dataWordInt(data: string, word: number, label: string): number {
  const start = 2 + word * 64;
  const slice = data.slice(start, start + 64);
  if (slice.length !== 64) {
    throw new Error(`checkpoint log source: data too short for ${label}`);
  }
  return hexToInt(`0x${slice}`, label);
}

export async function fetchLatestBlock(rpcUrls: string[]): Promise<number> {
  const result = await ethRpcWithFailover(rpcUrls, "eth_blockNumber", []);
  return hexToInt(result as string, "eth_blockNumber result");
}

/**
 * Fetch and decode `CheckpointPublished` events for one contract over an
 * inclusive block range. The address filter scopes results to the account's
 * instance; callers keep ranges bounded (RPC providers cap getLogs spans).
 */
export async function fetchCheckpointEvents(
  rpcUrls: string[],
  contractAddress: string,
  fromBlock: number,
  toBlock: number,
): Promise<CheckpointLogEvent[]> {
  const result = await ethRpcWithFailover(rpcUrls, "eth_getLogs", [
    {
      address: contractAddress,
      fromBlock: `0x${fromBlock.toString(16)}`,
      toBlock: `0x${toBlock.toString(16)}`,
      topics: [CHECKPOINT_PUBLISHED_TOPIC0],
    },
  ]);
  if (!Array.isArray(result)) {
    throw new Error("checkpoint log source: eth_getLogs returned non-array");
  }
  const events: CheckpointLogEvent[] = [];
  for (const log of result as RpcLog[]) {
    // Layout tripwire BEFORE quarantine: a shifted layout must stall, not be
    // skipped as N malformed events (plan-2607-03 R2).
    const data = log.data ?? "0x";
    if (data.length >= 2 + 5 * 64) {
      const headOffset = dataWordInt(data, 4, "accumulator head offset");
      if (headOffset !== ACCUMULATOR_HEAD_OFFSET) {
        throw new Error(
          `checkpoint log source: data word 4 is ${headOffset}, expected ${ACCUMULATOR_HEAD_OFFSET} — event layout drift?`,
        );
      }
    }
    // Per-event quarantine: a malformed log is skipped with a warning and
    // the range still applies — a permanently missed event is the ADR-0058
    // §7 trade and the reconciliation backstop's job; a permanent stall
    // would also block every later event (plan-2607-03 B2).
    try {
      const txHash = log.transactionHash;
      if (!txHash) {
        throw new Error("log missing transactionHash");
      }
      const logIndex = hexToInt(log.logIndex, "logIndex");
      const logId = log.topics?.[1];
      if (!logId) {
        throw new Error("log missing topics[1] (logId)");
      }
      events.push({
        idempotencyKey: `${txHash}:${logIndex}`,
        logId,
        logKind: dataWordInt(data, 2, "logKind"),
        size: dataWordInt(data, 3, "size"),
        blockNumber: hexToInt(log.blockNumber, "blockNumber"),
      });
    } catch (error) {
      console.warn(
        `checkpoint log source: skipped malformed log (tx ${log.transactionHash ?? "?"} index ${log.logIndex ?? "?"}): ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return events;
}

/**
 * Scan bound: the chain's `safe` head where served, else `latest` minus
 * `fallbackConfirmations`. The safe tag sits behind every honest replica's
 * view, which is what makes advancing a monotonic watermark against a
 * load-balanced RPC pool sound (plan-2607-03 B3) — a number-lag off the
 * unsafe head is not.
 */
export async function fetchScanBound(
  rpcUrls: string[],
  fallbackConfirmations: number,
): Promise<number> {
  try {
    const block = (await ethRpcWithFailover(rpcUrls, "eth_getBlockByNumber", [
      "safe",
      false,
    ])) as { number?: string } | null;
    if (block?.number) {
      return hexToInt(block.number, "safe block number");
    }
  } catch {
    // Chain (or node) does not serve the tag; fall through.
  }
  const latest = await fetchLatestBlock(rpcUrls);
  return latest - fallbackConfirmations;
}
