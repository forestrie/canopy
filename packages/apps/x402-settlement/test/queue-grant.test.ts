/**
 * Queue consumer: settled `kind="grant"` jobs credit the instance pool with
 * their revenue-equivalent (plan-2608-09 O2). Same post-settlement crediting
 * path as `credits` jobs (queue-credits.test.ts); settlement stubbed at the
 * facilitator fetch. A grant carrying `credits: 0` (sub-credit purchase) settles
 * but does not top up the pool.
 */
import { env, createExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SettlementJob } from "@canopy/x402-settlement-types";
import worker from "../src/index.js";
import type { Env } from "../src/env.js";

const typedEnv = env as Env;

const ADDR = "c3".repeat(20);
const INSTANCE_ID = `eip155:84532:0x${ADDR}`;
const ROOT = "33333333-3333-4333-8333-333333333333";
const TARGET_LOG = "44444444-4444-4444-8444-444444444444";

function grantJob(overrides: Partial<SettlementJob> = {}): SettlementJob {
  return {
    jobId: "grant-job-1",
    kind: "grant",
    authId: "local:0x0c552c20eee6644112b4965ff70f929c4ab80d4b",
    scheme: "exact",
    payer: "0x0c552c20eee6644112b4965ff70f929c4ab80d4b",
    amount: "50000",
    logId: TARGET_LOG,
    univocityInstanceId: INSTANCE_ID,
    credits: 5, // 50000 / 10000 (credit price) = 5
    idempotencyKey: `grant:${TARGET_LOG}:0xg1`,
    createdAt: 1_700_000_000_000,
    payload: {
      x402Version: 2,
      payload: {
        signature: "0xsig",
        authorization: {
          from: "0x0c552c20eee6644112b4965ff70f929c4ab80d4b",
          to: "0x75be7950F26fe7F15336a10b33A8D8134faDb787",
          value: "50000",
          validAfter: "0",
          validBefore: "9999999999",
          nonce: "0xg1",
        },
      },
      resource: {
        url: "https://x/register/grants",
        mimeType: "application/cbor",
      },
      accepted: {
        scheme: "exact",
        network: "eip155:84532",
        amount: "50000",
        asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
        payTo: "0x75be7950F26fe7F15336a10b33A8D8134faDb787",
      },
    },
    ...overrides,
  };
}

interface FakeMessage {
  body: SettlementJob;
  ack: ReturnType<typeof vi.fn>;
  retry: ReturnType<typeof vi.fn>;
}

function fakeBatch(jobs: SettlementJob[]): {
  batch: MessageBatch<SettlementJob>;
  messages: FakeMessage[];
} {
  const messages: FakeMessage[] = jobs.map((body) => ({
    body,
    ack: vi.fn(),
    retry: vi.fn(),
  }));
  return {
    batch: {
      messages,
      queue: "test-queue",
    } as unknown as MessageBatch<SettlementJob>,
    messages,
  };
}

function stubSettleOk(): void {
  globalThis.fetch = vi.fn(
    async () =>
      new Response(
        JSON.stringify({ success: true, transaction: "0xfeedbeef" }),
        { status: 200 },
      ),
  ) as typeof fetch;
}

const originalFetch = globalThis.fetch;
beforeEach(async () => {
  await typedEnv.R2_GRANTS!.put(
    `forests/index/chain-binding/${INSTANCE_ID}`,
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

function receivables() {
  return typedEnv.RECEIVABLES_DO.get(
    typedEnv.RECEIVABLES_DO.idFromName(INSTANCE_ID),
  );
}

describe("queue consumer — grant jobs (O2)", () => {
  it("credits the instance pool with the grant revenue-equivalent, idempotently", async () => {
    stubSettleOk();
    const { batch, messages } = fakeBatch([grantJob()]);
    await worker.queue(batch, typedEnv, createExecutionContext());
    expect(messages[0]!.ack).toHaveBeenCalled();
    expect(messages[0]!.retry).not.toHaveBeenCalled();

    const state = await receivables().getIndexState(INSTANCE_ID);
    expect(state.entitlement?.creditsBalance).toBe(5);

    // Redelivery: recordPayment dedups on the grant idempotencyKey.
    const again = fakeBatch([grantJob()]);
    await worker.queue(again.batch, typedEnv, createExecutionContext());
    const after = await receivables().getIndexState(INSTANCE_ID);
    expect(after.entitlement?.creditsBalance).toBe(5);
  });

  it("settles a sub-credit grant (credits: 0) without crediting the pool", async () => {
    stubSettleOk();
    const { batch, messages } = fakeBatch([
      grantJob({ credits: 0, idempotencyKey: `grant:${TARGET_LOG}:0xg2` }),
    ]);
    await worker.queue(batch, typedEnv, createExecutionContext());
    expect(messages[0]!.ack).toHaveBeenCalled();
    expect(messages[0]!.retry).not.toHaveBeenCalled();
    const state = await receivables().getIndexState(INSTANCE_ID);
    expect(state.entitlement?.creditsBalance ?? 0).toBe(0);
  });

  it("retries (not acks) when the fee account cannot be resolved", async () => {
    stubSettleOk();
    const unknown = `eip155:84532:0x${"ee".repeat(20)}`;
    const { batch, messages } = fakeBatch([
      grantJob({
        univocityInstanceId: unknown,
        idempotencyKey: `grant:${TARGET_LOG}:0xg3`,
      }),
    ]);
    await worker.queue(batch, typedEnv, createExecutionContext());
    expect(messages[0]!.retry).toHaveBeenCalled();
    expect(messages[0]!.ack).not.toHaveBeenCalled();
  });

  it("does not credit when settlement fails", async () => {
    globalThis.fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ success: false, errorReason: "declined" }),
          { status: 200 },
        ),
    ) as typeof fetch;
    const { batch, messages } = fakeBatch([
      grantJob({ idempotencyKey: `grant:${TARGET_LOG}:0xg4` }),
    ]);
    await worker.queue(batch, typedEnv, createExecutionContext());
    expect(messages[0]!.ack).toHaveBeenCalled();
    const state = await receivables().getIndexState(INSTANCE_ID);
    expect(state.entitlement?.creditsBalance ?? 0).toBe(0);
  });
});
