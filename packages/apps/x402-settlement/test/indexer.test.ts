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
  /** Override the raw data hex (poisoned-log and layout fixtures). */
  data?: string;
}) {
  return {
    transactionHash: opts.txHash,
    logIndex: `0x${opts.logIndex.toString(16)}`,
    blockNumber: `0x${opts.block.toString(16)}`,
    topics: [CHECKPOINT_PUBLISHED_TOPIC0, `0x${"11".repeat(32)}`],
    data:
      opts.data ??
      `0x${word(0)}${word(0)}${word(opts.logKind)}${word(opts.size)}`,
  };
}

/** Full 7-word head as emitted on chain: word 4 is the accumulator offset. */
function fullHeadData(logKind: number, size: number): string {
  return `0x${word(0)}${word(0)}${word(logKind)}${word(size)}${word(0xe0)}${word(1)}${word(0x120)}`;
}

function stubRpc(opts: {
  head: number;
  /** Safe-tag head; defaults to head - 6. "unsupported" serves null. */
  safe?: number | "unsupported";
  logs: unknown[];
}) {
  const calls: { method: string; params: unknown[] }[] = [];
  const safe = opts.safe ?? opts.head - 6;
  const fetchImpl = vi.fn(
    async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as {
        method: string;
        params: unknown[];
      };
      calls.push(body);
      if (body.method === "eth_getBlockByNumber") {
        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            result:
              safe === "unsupported"
                ? null
                : { number: `0x${safe.toString(16)}` },
          }),
          { status: 200 },
        );
      }
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
  vi.restoreAllMocks();
});

function stubOf(id: string) {
  return typedEnv.RECEIVABLES_DO.get(typedEnv.RECEIVABLES_DO.idFromName(id));
}

const ACCOUNT = {
  univocityInstanceId: INSTANCE_ID,
  chainId: "84532",
  univocityAddr: ADDR,
  root: ROOT,
};

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

  it("decodes a full on-chain-shaped head (7 words, offset word intact)", async () => {
    const { fetchImpl } = stubRpc({
      head: 0,
      logs: [
        rpcLog({
          txHash: "0xbb",
          logIndex: 0,
          block: 91,
          logKind: 1,
          size: 5,
          data: fullHeadData(1, 5),
        }),
      ],
    });
    globalThis.fetch = fetchImpl;
    const events = await fetchCheckpointEvents(
      ["https://rpc.example.invalid"],
      `0x${ADDR}`,
      1,
      100,
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ logKind: 1, size: 5 });
  });

  it("skips malformed logs with a warning instead of throwing the range", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { fetchImpl } = stubRpc({
      head: 0,
      logs: [
        rpcLog({ txHash: "0xok", logIndex: 0, block: 90, logKind: 1, size: 2 }),
        // Short data: too few words for logKind/size.
        rpcLog({
          txHash: "0xshort",
          logIndex: 1,
          block: 90,
          logKind: 0,
          size: 0,
          data: `0x${word(0)}`,
        }),
        // Non-hex logIndex.
        {
          ...rpcLog({
            txHash: "0xbadidx",
            logIndex: 0,
            block: 90,
            logKind: 1,
            size: 1,
          }),
          logIndex: "0xzz",
        },
        // size word exceeds Number.isSafeInteger.
        rpcLog({
          txHash: "0xhuge",
          logIndex: 3,
          block: 90,
          logKind: 0,
          size: 0,
          data: `0x${word(0)}${word(0)}${word(1)}${"f".repeat(64)}`,
        }),
      ],
    });
    globalThis.fetch = fetchImpl;
    const events = await fetchCheckpointEvents(
      ["https://rpc.example.invalid"],
      `0x${ADDR}`,
      1,
      100,
    );
    expect(events).toHaveLength(1);
    expect(events[0]!.idempotencyKey).toBe("0xok:0");
    expect(warn).toHaveBeenCalledTimes(3);
    expect(warn.mock.calls.map((c) => String(c[0]))).toEqual(
      expect.arrayContaining([
        expect.stringContaining("0xshort"),
        expect.stringContaining("0xbadidx"),
        expect.stringContaining("0xhuge"),
      ]),
    );
  });

  it("throws the whole range when the accumulator offset word shifts (layout tripwire)", async () => {
    const shifted = `0x${word(0)}${word(0)}${word(1)}${word(2)}${word(0x100)}${word(1)}${word(0x120)}`;
    const { fetchImpl } = stubRpc({
      head: 0,
      logs: [
        rpcLog({
          txHash: "0xdrift",
          logIndex: 0,
          block: 90,
          logKind: 0,
          size: 0,
          data: shifted,
        }),
      ],
    });
    globalThis.fetch = fetchImpl;
    await expect(
      fetchCheckpointEvents(
        ["https://rpc.example.invalid"],
        `0x${ADDR}`,
        1,
        100,
      ),
    ).rejects.toThrow(/layout drift/);
  });
});

describe("runCheckpointIndexer", () => {
  it("initialises the watermark at the safe head on first sight (observe-forward)", async () => {
    const { fetchImpl, calls } = stubRpc({ head: 2006, logs: [] });
    globalThis.fetch = fetchImpl;
    const summary = await runCheckpointIndexer(typedEnv);
    expect(summary.accounts).toBe(1);
    expect(summary.errors).toBe(0);
    // No scan on first sight — the watermark is planted at the safe head.
    expect(calls.some((c) => c.method === "eth_getLogs")).toBe(false);
    const state = await stubOf(INSTANCE_ID).getIndexState(INSTANCE_ID);
    expect(state.lastBlock).toBe(2000);
  });

  it("requests the scan bound via the safe tag, once per chain", async () => {
    const addr2 = "cd".repeat(20);
    const instance2 = `eip155:84532:0x${addr2}`;
    await typedEnv.R2_GRANTS!.put(
      `forests/index/chain-binding/${instance2}`,
      JSON.stringify({
        state: "registered",
        holder: "genesis",
        reservedAt: 1719000000,
        r: "33333333-3333-4333-8333-333333333333",
      }),
    );
    const { fetchImpl, calls } = stubRpc({ head: 2006, logs: [] });
    globalThis.fetch = fetchImpl;
    const summary = await runCheckpointIndexer(typedEnv);
    expect(summary.accounts).toBe(2);
    const headCalls = calls.filter((c) => c.method === "eth_getBlockByNumber");
    // Two accounts, one chain: exactly one scan-bound fetch (plan-2607-03 E1).
    expect(headCalls).toHaveLength(1);
    expect(headCalls[0]!.params).toEqual(["safe", false]);
    expect(calls.some((c) => c.method === "eth_blockNumber")).toBe(false);
  });

  it("falls back to latest minus confirmations when the safe tag is unsupported", async () => {
    const { fetchImpl } = stubRpc({
      head: 2006,
      safe: "unsupported",
      logs: [],
    });
    globalThis.fetch = fetchImpl;
    const summary = await runCheckpointIndexer(typedEnv);
    expect(summary.errors).toBe(0);
    const state = await stubOf(INSTANCE_ID).getIndexState(INSTANCE_ID);
    expect(state.lastBlock).toBe(2000);
  });

  it("scans from the watermark, accrues idempotently, and advances", async () => {
    // Pre-seed a watermark so the sweep scans 1001..2000.
    await stubOf(INSTANCE_ID).applyCheckpointEvents(ACCOUNT, [], 1000);

    const logs = [
      rpcLog({ txHash: "0xt1", logIndex: 0, block: 1500, logKind: 1, size: 3 }),
      rpcLog({ txHash: "0xt2", logIndex: 1, block: 1700, logKind: 2, size: 9 }),
    ];
    const { fetchImpl, calls } = stubRpc({ head: 2006, logs });
    globalThis.fetch = fetchImpl;

    const summary = await runCheckpointIndexer(typedEnv);
    expect(summary.applied).toBe(2);
    // Exact wire-level range: watermark+1 .. safe head, inclusive hex.
    const getLogs = calls.filter((c) => c.method === "eth_getLogs");
    expect(getLogs).toHaveLength(1);
    expect(getLogs[0]!.params[0]).toEqual({
      address: `0x${ADDR}`,
      fromBlock: "0x3e9",
      toBlock: "0x7d0",
      topics: [CHECKPOINT_PUBLISHED_TOPIC0],
    });
    const state = await stubOf(INSTANCE_ID).getIndexState(INSTANCE_ID);
    expect(state.lastBlock).toBe(2000);
    expect(state.entitlement?.checkpointsAccrued).toBe(2);
    expect(state.entitlement?.creditsBalance).toBe(-2);
    expect(state.entitlement?.arrears).toBe("in-arrears");

    // Re-run over the same chain state: same events replayed, nothing double
    // counted — the source is at-least-once by design.
    await stubOf(INSTANCE_ID).applyCheckpointEvents(ACCOUNT, [], 1000);
    globalThis.fetch = stubRpc({ head: 2006, logs }).fetchImpl;
    await runCheckpointIndexer(typedEnv);
    const after = await stubOf(INSTANCE_ID).getIndexState(INSTANCE_ID);
    expect(after.entitlement?.checkpointsAccrued).toBe(2);
  });

  it("applies the range and advances past poisoned logs (quarantine)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await stubOf(INSTANCE_ID).applyCheckpointEvents(ACCOUNT, [], 1000);
    const logs = [
      rpcLog({ txHash: "0xok", logIndex: 0, block: 1500, logKind: 1, size: 3 }),
      rpcLog({
        txHash: "0xpoison",
        logIndex: 1,
        block: 1500,
        logKind: 0,
        size: 0,
        data: `0x${word(0)}`,
      }),
    ];
    globalThis.fetch = stubRpc({ head: 2006, logs }).fetchImpl;
    const summary = await runCheckpointIndexer(typedEnv);
    expect(summary.errors).toBe(0);
    expect(summary.applied).toBe(1);
    const state = await stubOf(INSTANCE_ID).getIndexState(INSTANCE_ID);
    expect(state.lastBlock).toBe(2000);
    expect(state.entitlement?.checkpointsAccrued).toBe(1);
    expect(warn).toHaveBeenCalled();
  });

  it("stalls the account without advancing on a layout-drifted log", async () => {
    await stubOf(INSTANCE_ID).applyCheckpointEvents(ACCOUNT, [], 1000);
    const shifted = `0x${word(0)}${word(0)}${word(1)}${word(2)}${word(0x100)}${word(1)}${word(0x120)}`;
    const logs = [
      rpcLog({
        txHash: "0xdrift",
        logIndex: 0,
        block: 1500,
        logKind: 0,
        size: 0,
        data: shifted,
      }),
    ];
    globalThis.fetch = stubRpc({ head: 2006, logs }).fetchImpl;
    const summary = await runCheckpointIndexer(typedEnv);
    expect(summary.errors).toBe(1);
    const state = await stubOf(INSTANCE_ID).getIndexState(INSTANCE_ID);
    // Watermark parks before the poisoned range: recoverable by rescan.
    expect(state.lastBlock).toBe(1000);
    expect(state.entitlement?.checkpointsAccrued ?? 0).toBe(0);
  });

  it("backfills a first-seen account from the per-chain map", async () => {
    const logs = [
      rpcLog({ txHash: "0xb1", logIndex: 0, block: 700, logKind: 1, size: 1 }),
    ];
    const { fetchImpl, calls } = stubRpc({ head: 2006, logs });
    globalThis.fetch = fetchImpl;
    const backfillEnv = {
      ...typedEnv,
      INDEXER_BACKFILL_FROM_BLOCK: '{"84532": 500}',
    } as Env;
    const summary = await runCheckpointIndexer(backfillEnv);
    expect(summary.applied).toBe(1);
    const getLogs = calls.filter((c) => c.method === "eth_getLogs");
    expect(getLogs[0]!.params[0]).toMatchObject({ fromBlock: "0x1f4" });
    const state = await stubOf(INSTANCE_ID).getIndexState(INSTANCE_ID);
    expect(state.lastBlock).toBe(2000);
  });

  it("ignores a backfill entry for another chain (observe-forward)", async () => {
    const { fetchImpl, calls } = stubRpc({ head: 2006, logs: [] });
    globalThis.fetch = fetchImpl;
    const backfillEnv = {
      ...typedEnv,
      INDEXER_BACKFILL_FROM_BLOCK: '{"1": 500}',
    } as Env;
    await runCheckpointIndexer(backfillEnv);
    expect(calls.some((c) => c.method === "eth_getLogs")).toBe(false);
    const state = await stubOf(INSTANCE_ID).getIndexState(INSTANCE_ID);
    expect(state.lastBlock).toBe(2000);
  });

  it("warns and observes forward on a malformed backfill value", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { fetchImpl, calls } = stubRpc({ head: 2006, logs: [] });
    globalThis.fetch = fetchImpl;
    const backfillEnv = {
      ...typedEnv,
      INDEXER_BACKFILL_FROM_BLOCK: "12345",
    } as Env;
    const summary = await runCheckpointIndexer(backfillEnv);
    expect(summary.errors).toBe(0);
    expect(calls.some((c) => c.method === "eth_getLogs")).toBe(false);
    expect(
      warn.mock.calls.some((c) =>
        String(c[0]).includes("INDEXER_BACKFILL_FROM_BLOCK"),
      ),
    ).toBe(true);
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

  it("a malformed chain config becomes a sweep-level failure, not a rejection", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const bad = { ...typedEnv, SUPPORTED_CHAINS_RPC: "{not json" } as Env;
    const summary = await runCheckpointIndexer(bad);
    expect(summary.errors).toBe(1);
    expect(
      error.mock.calls.some((c) => String(c[0]).includes("sweep failed")),
    ).toBe(true);
  });

  it("skips the sweep without SUPPORTED_CHAINS_RPC", async () => {
    const bare = { ...typedEnv, SUPPORTED_CHAINS_RPC: undefined } as Env;
    const summary = await runCheckpointIndexer(bare);
    expect(summary.accounts).toBe(0);
  });
});
