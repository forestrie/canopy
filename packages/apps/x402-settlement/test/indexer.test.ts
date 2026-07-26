/**
 * Accrual indexer (plan-2607-43 slice 03) against a mocked chain RPC and the
 * real R2 reservation registry + ReceivablesDO from the pool env.
 */
import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env.js";
import { runCheckpointIndexer } from "../src/indexer/run-indexer.js";
import {
  CHECKPOINT_PUBLISHED_TOPIC0,
  fetchCheckpointEvents,
} from "../src/indexer/checkpoint-log-source.js";

const typedEnv = env as Env;

const ADDR = "ab".repeat(20);
const INSTANCE_ID = `eip155:84532:0x${ADDR}`;
const ROOT = "22222222-2222-4222-8222-222222222222";
const RESERVATION_KEY = `forests/index/chain-binding/${INSTANCE_ID}`;

function word(n: number): string {
  return n.toString(16).padStart(64, "0");
}

/** A CheckpointPublished log with static head words sender|idts|kind|size. */
function rpcLog(opts: {
  txHash: string;
  logIndex: number;
  block: number;
  logKind: number;
  size: number;
}) {
  return {
    transactionHash: opts.txHash,
    logIndex: `0x${opts.logIndex.toString(16)}`,
    blockNumber: `0x${opts.block.toString(16)}`,
    topics: [CHECKPOINT_PUBLISHED_TOPIC0, `0x${"11".repeat(32)}`],
    data: `0x${word(0)}${word(0)}${word(opts.logKind)}${word(opts.size)}`,
  };
}

function stubRpc(opts: { head: number; logs: unknown[] }) {
  const calls: { method: string; params: unknown[] }[] = [];
  const fetchImpl = vi.fn(
    async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as {
        method: string;
        params: unknown[];
      };
      calls.push(body);
      if (body.method === "eth_blockNumber") {
        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            result: `0x${opts.head.toString(16)}`,
          }),
          { status: 200 },
        );
      }
      if (body.method === "eth_getLogs") {
        return new Response(
          JSON.stringify({ jsonrpc: "2.0", id: 1, result: opts.logs }),
          { status: 200 },
        );
      }
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          error: { message: "unexpected" },
        }),
        { status: 200 },
      );
    },
  ) as typeof fetch;
  return { fetchImpl, calls };
}

const originalFetch = globalThis.fetch;
beforeEach(async () => {
  await typedEnv.R2_GRANTS!.put(
    RESERVATION_KEY,
    JSON.stringify({
      state: "registered",
      holder: "genesis",
      reservedAt: 1719000000,
      r: ROOT,
    }),
  );
});
afterEach(() => {
  globalThis.fetch = originalFetch;
});

function stubOf(id: string) {
  return typedEnv.RECEIVABLES_DO.get(typedEnv.RECEIVABLES_DO.idFromName(id));
}

describe("checkpoint log source", () => {
  it("decodes the static head words and keys by txHash:logIndex", async () => {
    const { fetchImpl } = stubRpc({
      head: 0,
      logs: [
        rpcLog({ txHash: "0xaa", logIndex: 3, block: 90, logKind: 2, size: 7 }),
      ],
    });
    globalThis.fetch = fetchImpl;
    const events = await fetchCheckpointEvents(
      ["https://rpc.example.invalid"],
      `0x${ADDR}`,
      1,
      100,
    );
    expect(events).toEqual([
      {
        idempotencyKey: "0xaa:3",
        logId: `0x${"11".repeat(32)}`,
        logKind: 2,
        size: 7,
        blockNumber: 90,
      },
    ]);
  });
});

describe("runCheckpointIndexer", () => {
  it("initialises the watermark at the confirmed head on first sight (observe-forward)", async () => {
    const { fetchImpl, calls } = stubRpc({ head: 2006, logs: [] });
    globalThis.fetch = fetchImpl;
    const summary = await runCheckpointIndexer(typedEnv);
    expect(summary.accounts).toBe(1);
    expect(summary.errors).toBe(0);
    // No scan on first sight — the watermark is planted at head - confirmations.
    expect(calls.some((c) => c.method === "eth_getLogs")).toBe(false);
    const state = await stubOf(INSTANCE_ID).getIndexState(INSTANCE_ID);
    expect(state.lastBlock).toBe(2000);
  });

  it("scans from the watermark, accrues idempotently, and advances", async () => {
    // Pre-seed a watermark so the sweep scans 1001..2000.
    const account = {
      univocityInstanceId: INSTANCE_ID,
      chainId: "84532",
      univocityAddr: ADDR,
      root: ROOT,
    };
    await stubOf(INSTANCE_ID).applyCheckpointEvents(account, [], 1000);

    const logs = [
      rpcLog({ txHash: "0xt1", logIndex: 0, block: 1500, logKind: 1, size: 3 }),
      rpcLog({ txHash: "0xt2", logIndex: 1, block: 1700, logKind: 2, size: 9 }),
    ];
    const { fetchImpl } = stubRpc({ head: 2006, logs });
    globalThis.fetch = fetchImpl;

    const summary = await runCheckpointIndexer(typedEnv);
    expect(summary.applied).toBe(2);
    const state = await stubOf(INSTANCE_ID).getIndexState(INSTANCE_ID);
    expect(state.lastBlock).toBe(2000);
    expect(state.entitlement?.checkpointsAccrued).toBe(2);
    expect(state.entitlement?.creditsBalance).toBe(-2);
    expect(state.entitlement?.arrears).toBe("in-arrears");

    // Re-run over the same chain state: same events replayed, nothing double
    // counted — the source is at-least-once by design.
    await stubOf(INSTANCE_ID).applyCheckpointEvents(account, [], 1000);
    globalThis.fetch = stubRpc({ head: 2006, logs }).fetchImpl;
    await runCheckpointIndexer(typedEnv);
    const after = await stubOf(INSTANCE_ID).getIndexState(INSTANCE_ID);
    expect(after.entitlement?.checkpointsAccrued).toBe(2);
  });

  it("skips reserved (unregistered) records", async () => {
    await typedEnv.R2_GRANTS!.put(
      RESERVATION_KEY,
      JSON.stringify({ state: "reserved", holder: "token:ff", reservedAt: 1 }),
    );
    const { fetchImpl, calls } = stubRpc({ head: 2006, logs: [] });
    globalThis.fetch = fetchImpl;
    const summary = await runCheckpointIndexer(typedEnv);
    expect(summary.accounts).toBe(0);
    expect(calls.length).toBe(0);
  });

  it("a failing RPC degrades to an error count, not a thrown sweep", async () => {
    globalThis.fetch = vi.fn(
      async () => new Response("boom", { status: 500 }),
    ) as typeof fetch;
    const summary = await runCheckpointIndexer(typedEnv);
    expect(summary.errors).toBe(1);
  });

  it("skips the sweep without SUPPORTED_CHAINS_RPC", async () => {
    const bare = { ...typedEnv, SUPPORTED_CHAINS_RPC: undefined } as Env;
    const summary = await runCheckpointIndexer(bare);
    expect(summary.accounts).toBe(0);
  });
});
