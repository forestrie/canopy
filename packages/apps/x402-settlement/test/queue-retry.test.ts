/**
 * Queue consumer: a settlement that fails for a transient reason is retried,
 * not acked away (FOR-616).
 *
 * canopy-api admits a paid request on verify and only then enqueues the
 * settlement job (mint-on-verify), so a job this worker drops is a payment
 * canopy never collects. On 2026-10-24 the x402.org facilitator answered
 * `/settle` with HTTP 200 `success:false` /
 * `invalid_exact_evm_transaction_failed` (its own eth_sendRawTransaction to
 * the public Base Sepolia RPC failed) for 6 of 15 lane-A settlements; each was
 * acked and the authorization expired unsettled.
 *
 * Retries stop while the EIP-3009 authorization can still settle: past its
 * `validBefore` the token contract refuses it, so retrying is pointless.
 */
import { env, createExecutionContext } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SettlementJob } from "@canopy/x402-settlement-types";
import worker from "../src/index.js";
import {
  MAX_SETTLE_ATTEMPTS,
  QUEUE_MAX_RETRIES,
  settleRetryDecision,
} from "../src/settle-retry.js";
import type { Env } from "../src/env.js";

const typedEnv = env as Env;

const PAYER = "0x7a381983d17ffbddc47218d170afda98293699ae";

function job(n: string, validBefore: number): SettlementJob {
  return {
    jobId: `retry-job-${n}`,
    kind: "grant",
    authId: `local:${PAYER}`,
    scheme: "exact",
    payer: PAYER,
    amount: "100000",
    logId: "55555555-5555-4555-8555-555555555555",
    idempotencyKey: `grant:retry:${n}`,
    createdAt: Date.now(),
    payload: {
      x402Version: 2,
      payload: {
        signature: "0xsig",
        authorization: {
          from: PAYER,
          to: "0x75be7950F26fe7F15336a10b33A8D8134faDb787",
          value: "100000",
          validAfter: "0",
          validBefore: String(validBefore),
          nonce: `0x${n}`,
        },
      },
      resource: {
        url: "https://x/register/grants",
        mimeType: "application/cbor",
      },
      accepted: {
        scheme: "exact",
        network: "eip155:84532",
        amount: "100000",
        asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
        payTo: "0x75be7950F26fe7F15336a10b33A8D8134faDb787",
      },
    },
  };
}

interface FakeMessage {
  body: SettlementJob;
  attempts: number;
  ack: ReturnType<typeof vi.fn>;
  retry: ReturnType<typeof vi.fn>;
}

function deliver(body: SettlementJob, attempts = 1) {
  const message: FakeMessage = { body, attempts, ack: vi.fn(), retry: vi.fn() };
  const batch = {
    messages: [message],
    queue: "test-queue",
  } as unknown as MessageBatch<SettlementJob>;
  return { batch, message };
}

/** The reply x402.org gave on 2026-10-24 (body abridged). */
function stubTransactionFailed(): void {
  globalThis.fetch = vi.fn(
    async () =>
      new Response(
        JSON.stringify({
          success: false,
          errorReason: "invalid_exact_evm_transaction_failed",
          errorMessage: "Missing or invalid parameters.",
        }),
        { status: 200 },
      ),
  ) as typeof fetch;
}

const nowSec = () => Math.floor(Date.now() / 1000);
const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe("queue consumer — transient settlement failures (FOR-616)", () => {
  it("retries, with a delay, when the facilitator's transaction failed", async () => {
    stubTransactionFailed();
    const { batch, message } = deliver(job("a1", nowSec() + 300));
    await worker.queue(batch, typedEnv, createExecutionContext());
    expect(message.ack).not.toHaveBeenCalled();
    expect(message.retry).toHaveBeenCalledTimes(1);
    const opts = message.retry.mock.calls[0]![0] as { delaySeconds: number };
    expect(opts.delaySeconds).toBeGreaterThan(0);
  });

  it("backs off on later attempts", async () => {
    stubTransactionFailed();
    const first = deliver(job("a2", nowSec() + 3600), 1);
    await worker.queue(first.batch, typedEnv, createExecutionContext());
    const third = deliver(job("a2", nowSec() + 3600), 3);
    await worker.queue(third.batch, typedEnv, createExecutionContext());
    const d1 = (
      first.message.retry.mock.calls[0]![0] as { delaySeconds: number }
    ).delaySeconds;
    const d3 = (
      third.message.retry.mock.calls[0]![0] as { delaySeconds: number }
    ).delaySeconds;
    expect(d3).toBeGreaterThan(d1);
  });

  it("retries on a facilitator 5xx", async () => {
    globalThis.fetch = vi.fn(
      async () => new Response("upstream unavailable", { status: 503 }),
    ) as typeof fetch;
    const { batch, message } = deliver(job("a3", nowSec() + 300));
    await worker.queue(batch, typedEnv, createExecutionContext());
    expect(message.retry).toHaveBeenCalledTimes(1);
    expect(message.ack).not.toHaveBeenCalled();
  });

  it("gives up (acks) once the authorization would expire before the retry", async () => {
    stubTransactionFailed();
    const errors = vi.spyOn(console, "error");
    const { batch, message } = deliver(job("a4", nowSec() + 5));
    await worker.queue(batch, typedEnv, createExecutionContext());
    expect(message.retry).not.toHaveBeenCalled();
    expect(message.ack).toHaveBeenCalledTimes(1);
    expect(
      errors.mock.calls.some((c) => c[0] === "Settlement abandoned"),
      "an abandoned settlement is logged as such",
    ).toBe(true);
  });

  it("gives up after the attempt cap even with a far validBefore", async () => {
    stubTransactionFailed();
    const { batch, message } = deliver(job("a5", nowSec() + 86_400), 8);
    await worker.queue(batch, typedEnv, createExecutionContext());
    expect(message.retry).not.toHaveBeenCalled();
    expect(message.ack).toHaveBeenCalledTimes(1);
  });

  it("still acks a permanent refusal without retrying", async () => {
    globalThis.fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            success: false,
            errorReason: "invalid_exact_evm_payload_signature",
          }),
          { status: 200 },
        ),
    ) as typeof fetch;
    const { batch, message } = deliver(job("a6", nowSec() + 300));
    await worker.queue(batch, typedEnv, createExecutionContext());
    expect(message.retry).not.toHaveBeenCalled();
    expect(message.ack).toHaveBeenCalledTimes(1);
  });

  it("transient failures do not block the payer's authorization", async () => {
    stubTransactionFailed();
    const authId = `local:0x${"ab".repeat(20)}`;
    for (let i = 0; i < 12; i++) {
      const j = { ...job(`b${i}`, nowSec() + 300), authId };
      const { batch } = deliver(j);
      await worker.queue(batch, typedEnv, createExecutionContext());
    }
    const shard = typedEnv.X402_SETTLEMENT_DO;
    // The consumer routes by authId; read the auth state from every shard.
    const states = await Promise.all(
      [0, 1, 2, 3].map((i) =>
        shard.get(shard.idFromName(`shard-${i}`)).getAuthInfo(authId),
      ),
    );
    const info = states.find((s) => s !== null);
    expect(info, "the failures were recorded").toBeTruthy();
    expect(info!.state).toBe("active");
    expect(info!.failureCount).toBe(0);
  });
});

/** A 32-byte nonce, so the DO can read the authorization on-chain. */
const nonce32 = (n: string) => `0x${n.padStart(64, "0")}`;

function onChainJob(n: string, validBefore: number): SettlementJob {
  const j = job(n, validBefore);
  j.payload.payload.authorization.nonce = nonce32(n);
  return j;
}

/**
 * Route fetch: JSON-RPC to the chain (wrangler.jsonc SUPPORTED_CHAINS_RPC)
 * answers `authorizationState` with `spent`; anything else is the
 * facilitator, answering `facilitatorReply`.
 */
function stubChainAndFacilitator(
  spent: () => boolean,
  facilitatorReply: Record<string, unknown>,
): ReturnType<typeof vi.fn> {
  const facilitator = vi.fn(
    async () => new Response(JSON.stringify(facilitatorReply), { status: 200 }),
  );
  globalThis.fetch = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.includes("sepolia.base.org")) {
        const req = JSON.parse(String(init?.body ?? "{}")) as { id?: number };
        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: req.id ?? 1,
            result: `0x${(spent() ? "1" : "0").padStart(64, "0")}`,
          }),
          { status: 200 },
        );
      }
      return facilitator();
    },
  ) as typeof fetch;
  return facilitator;
}

async function authInfo(authId: string) {
  const shard = typedEnv.X402_SETTLEMENT_DO;
  const states = await Promise.all(
    [0, 1, 2, 3].map((i) =>
      shard.get(shard.idFromName(`shard-${i}`)).getAuthInfo(authId),
    ),
  );
  return states.find((s) => s !== null) ?? null;
}

describe("settlement DO — the chain decides whether the money moved (FOR-616)", () => {
  it("books a retry as settled when the facilitator's failed attempt mined", async () => {
    // Attempt 1: the facilitator reports transaction_failed, but its
    // broadcast mines afterwards. Attempt 2 must not be booked unpaid.
    let mined = false;
    const facilitator = stubChainAndFacilitator(() => mined, {
      success: false,
      errorReason: "transaction_failed",
    });
    const j = onChainJob("c1", nowSec() + 300);
    const first = deliver(j, 1);
    await worker.queue(first.batch, typedEnv, createExecutionContext());
    expect(first.message.retry).toHaveBeenCalledTimes(1);

    mined = true;
    const second = deliver(j, 2);
    await worker.queue(second.batch, typedEnv, createExecutionContext());
    expect(second.message.retry).not.toHaveBeenCalled();
    expect(second.message.ack).toHaveBeenCalledTimes(1);
    expect(
      facilitator,
      "no second settle once the chain shows it spent",
    ).toHaveBeenCalledTimes(1);

    // Booked: a third delivery hits the idempotency record.
    const third = deliver(j, 3);
    await worker.queue(third.batch, typedEnv, createExecutionContext());
    expect(third.message.ack).toHaveBeenCalledTimes(1);
    expect(facilitator).toHaveBeenCalledTimes(1);
  });

  it("a nonce-already-used refusal with the nonce spent is a settlement, not a payer failure", async () => {
    let calls = 0;
    // Unspent on the pre-attempt read, spent by the time of the refusal.
    stubChainAndFacilitator(() => calls++ > 0, {
      success: false,
      errorReason: "invalid_exact_evm_nonce_already_used",
    });
    const j = {
      ...onChainJob("c2", nowSec() + 300),
      authId: `local:0x${"cd".repeat(20)}`,
    };
    const { batch, message } = deliver(j);
    await worker.queue(batch, typedEnv, createExecutionContext());
    expect(message.ack).toHaveBeenCalledTimes(1);
    expect(message.retry).not.toHaveBeenCalled();
    expect((await authInfo(j.authId))?.failureCount ?? 0).toBe(0);
  });

  it("an expired authorization is abandoned without asking the facilitator or blaming the payer", async () => {
    const facilitator = stubChainAndFacilitator(() => false, {
      success: true,
      transaction: "0x1",
    });
    const errors = vi.spyOn(console, "error");
    const j = {
      ...onChainJob("c3", nowSec() + 3),
      authId: `local:0x${"ef".repeat(20)}`,
    };
    const { batch, message } = deliver(j, 4);
    await worker.queue(batch, typedEnv, createExecutionContext());
    expect(facilitator).not.toHaveBeenCalled();
    expect(message.ack).toHaveBeenCalledTimes(1);
    expect(message.retry).not.toHaveBeenCalled();
    expect(errors.mock.calls.some((c) => c[0] === "Settlement abandoned")).toBe(
      true,
    );
    const info = await authInfo(j.authId);
    expect(info?.failureCount ?? 0).toBe(0);
    expect(info?.state ?? "active").toBe("active");
  });

  it("a facilitator valid_before refusal is abandoned, not counted against the payer", async () => {
    stubChainAndFacilitator(() => false, {
      success: false,
      errorReason: "invalid_exact_evm_payload_authorization_valid_before",
    });
    const errors = vi.spyOn(console, "error");
    const j = {
      ...onChainJob("c4", nowSec() + 300),
      authId: `local:0x${"12".repeat(20)}`,
    };
    const { batch, message } = deliver(j, 3);
    await worker.queue(batch, typedEnv, createExecutionContext());
    expect(message.ack).toHaveBeenCalledTimes(1);
    expect(errors.mock.calls.some((c) => c[0] === "Settlement abandoned")).toBe(
      true,
    );
    expect((await authInfo(j.authId))?.failureCount ?? 0).toBe(0);
  });
});

describe("settleRetryDecision", () => {
  const at = (validBefore: string): SettlementJob => ({
    ...job("d1", 0),
    payload: {
      ...job("d1", 0).payload,
      payload: {
        ...job("d1", 0).payload.payload,
        authorization: {
          ...job("d1", 0).payload.payload.authorization,
          validBefore,
        },
      },
    },
  });
  const NOW = 1_800_000_000;

  it("backs off 10, 20, 40, 60, 60s", () => {
    const delays = [1, 2, 3, 4, 5].map((n) => {
      const d = settleRetryDecision(at(String(NOW + 3600)), n, NOW);
      return d.retry ? d.delaySeconds : -1;
    });
    expect(delays).toEqual([10, 20, 40, 60, 60]);
  });

  it("stops at the attempt cap", () => {
    expect(
      settleRetryDecision(at(String(NOW + 3600)), MAX_SETTLE_ATTEMPTS, NOW)
        .retry,
    ).toBe(false);
    expect(
      settleRetryDecision(at(String(NOW + 3600)), MAX_SETTLE_ATTEMPTS - 1, NOW)
        .retry,
    ).toBe(true);
  });

  it("stops when the retry could not settle before validBefore", () => {
    // delay 10 + margin 45 = 55s needed.
    expect(settleRetryDecision(at(String(NOW + 56)), 1, NOW).retry).toBe(true);
    expect(settleRetryDecision(at(String(NOW + 55)), 1, NOW).retry).toBe(false);
  });

  it("does not retry without a usable validBefore", () => {
    expect(settleRetryDecision(at("not-a-number"), 1, NOW).retry).toBe(false);
  });

  it("keeps the attempt cap inside the queue's delivery budget", () => {
    expect(MAX_SETTLE_ATTEMPTS).toBeLessThanOrEqual(QUEUE_MAX_RETRIES + 1);
  });
});
