/**
 * Queue consumer: settled `kind="credits"` jobs credit the ReceivablesDO
 * (plan-2607-43 slice 04). Settlement is stubbed at the facilitator fetch.
 */
import { env, createExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SettlementJob } from "@canopy/x402-settlement-types";
import worker from "../src/index.js";
import type { Env } from "../src/env.js";

const typedEnv = env as Env;

const ADDR = "ab".repeat(20);
const INSTANCE_ID = `eip155:84532:0x${ADDR}`;
const ROOT = "22222222-2222-4222-8222-222222222222";

function creditsJob(overrides: Partial<SettlementJob> = {}): SettlementJob {
  return {
    jobId: "job-1",
    kind: "credits",
    authId: "local:0x0c552c20eee6644112b4965ff70f929c4ab80d4b",
    scheme: "exact",
    payer: "0x0c552c20eee6644112b4965ff70f929c4ab80d4b",
    amount: "70000",
    univocityInstanceId: INSTANCE_ID,
    credits: 7,
    idempotencyKey: `credits:${INSTANCE_ID}:0xn1`,
    createdAt: 1_700_000_000_000,
    payload: {
      x402Version: 2,
      payload: {
        signature: "0xsig",
        authorization: {
          from: "0x0c552c20eee6644112b4965ff70f929c4ab80d4b",
          to: "0x75be7950F26fe7F15336a10b33A8D8134faDb787",
          value: "70000",
          validAfter: "0",
          validBefore: "9999999999",
          nonce: "0xn1",
        },
      },
      resource: { url: "https://x/credits", mimeType: "application/json" },
      accepted: {
        scheme: "exact",
        network: "eip155:84532",
        amount: "70000",
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

describe("queue consumer — credits jobs", () => {
  it("credits the account after settlement, idempotently across redelivery", async () => {
    stubSettleOk();
    const { batch, messages } = fakeBatch([creditsJob()]);
    await worker.queue(batch, typedEnv, createExecutionContext());
    expect(messages[0]!.ack).toHaveBeenCalled();
    expect(messages[0]!.retry).not.toHaveBeenCalled();

    const state = await receivables().getIndexState(INSTANCE_ID);
    expect(state.entitlement?.creditsBalance).toBe(7);

    // Redelivery: settle is cached in settled_jobs, recordPayment dedups.
    const again = fakeBatch([creditsJob()]);
    await worker.queue(again.batch, typedEnv, createExecutionContext());
    const after = await receivables().getIndexState(INSTANCE_ID);
    expect(after.entitlement?.creditsBalance).toBe(7);
  });

  it("retries (not acks) when the account cannot be resolved", async () => {
    stubSettleOk();
    const unknown = `eip155:84532:0x${"dd".repeat(20)}`;
    const { batch, messages } = fakeBatch([
      creditsJob({
        univocityInstanceId: unknown,
        idempotencyKey: `credits:${unknown}:0xn2`,
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
      creditsJob({ idempotencyKey: `credits:${INSTANCE_ID}:0xn3` }),
    ]);
    await worker.queue(batch, typedEnv, createExecutionContext());
    expect(messages[0]!.ack).toHaveBeenCalled();
    const state = await receivables().getIndexState(INSTANCE_ID);
    expect(state.entitlement?.creditsBalance ?? 0).toBe(0);
  });
});
