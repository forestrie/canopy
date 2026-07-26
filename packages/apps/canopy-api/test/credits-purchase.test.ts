/**
 * `POST /api/payments/credits/{univocityInstanceId}` — payer-facing x402
 * credits purchase (plan-2607-43 slice 04).
 */
import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SettlementJob } from "@canopy/x402-settlement-types";
import { handlePaymentsRequest } from "../src/payments/handle-payments-request.js";
import type { PaymentsHandlerEnv } from "../src/payments/handle-payments-request.js";
import { completeUnivocityInstanceReservation } from "../src/payments/instance-registry.js";
import { reserveUnivocityInstance } from "../src/payments/instance-registry.js";
import type { Env } from "../src/index";

const poolEnv = env as unknown as Env;

const PAY_TO = "0x75be7950F26fe7F15336a10b33A8D8134faDb787";
const USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const ROOT = "44444444-4444-4444-8444-444444444444";

let addrCounter = 0x10;
function freshInstance(): string {
  const byte = (addrCounter++).toString(16).padStart(2, "0");
  return `eip155:84532:0x${byte.repeat(20)}`;
}

function creditsEnv(overrides: Record<string, unknown> = {}): {
  handlerEnv: PaymentsHandlerEnv;
  sent: SettlementJob[];
} {
  const sent: SettlementJob[] = [];
  const handlerEnv = {
    ...poolEnv,
    CANOPY_OPS_ADMIN_TOKEN: "vitest-ops-admin-token",
    X402_NETWORK: "eip155:84532",
    X402_PAYTO_ADDRESS: PAY_TO,
    X402_CREDIT_PRICE_ATOMIC: "10000",
    X402_FACILITATOR_URL: "https://facilitator.invalid",
    X402_SETTLEMENT_QUEUE: {
      send: async (job: SettlementJob) => {
        sent.push(job);
      },
    },
    ...overrides,
  } as unknown as PaymentsHandlerEnv;
  return { handlerEnv, sent };
}

function paymentHeader(amount: string, nonce: string): string {
  return btoa(
    JSON.stringify({
      x402Version: 2,
      payload: {
        signature: "0xsig",
        authorization: {
          from: "0x0c552c20eee6644112b4965ff70f929c4ab80d4b",
          to: PAY_TO,
          value: amount,
          validAfter: "0",
          validBefore: "9999999999",
          nonce,
        },
      },
      resource: { url: "https://x/credits", mimeType: "application/json" },
      accepted: {
        scheme: "exact",
        network: "eip155:84532",
        amount,
        asset: USDC,
        payTo: PAY_TO,
      },
    }),
  );
}

async function post(
  handlerEnv: PaymentsHandlerEnv,
  id: string,
  opts?: { credits?: string; payment?: string; method?: string },
): Promise<Response> {
  const qs = opts?.credits !== undefined ? `?credits=${opts.credits}` : "";
  const url = `https://api.test/api/payments/credits/${encodeURIComponent(id)}${qs}`;
  const res = await handlePaymentsRequest(
    new Request(url, {
      method: opts?.method ?? "POST",
      headers: opts?.payment ? { "X-PAYMENT": opts.payment } : {},
    }),
    new URL(url).pathname,
    handlerEnv,
    {},
  );
  expect(res).not.toBeNull();
  return res!;
}

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

function stubFacilitatorValid(): void {
  globalThis.fetch = vi.fn(
    async () =>
      new Response(JSON.stringify({ isValid: true }), { status: 200 }),
  ) as typeof fetch;
}

describe("credits purchase route", () => {
  it("rejects non-POST and non-canonical ids", async () => {
    const { handlerEnv } = creditsEnv();
    const id = freshInstance();
    await completeUnivocityInstanceReservation(poolEnv, id, [], ROOT);
    expect((await post(handlerEnv, id, { method: "GET" })).status).toBe(405);
    expect((await post(handlerEnv, "eip155:84532:nothex")).status).toBe(400);
  });

  it("404s an unknown instance and 409s a reserved-but-unregistered one", async () => {
    const { handlerEnv } = creditsEnv();
    expect((await post(handlerEnv, freshInstance())).status).toBe(404);

    const reserved = freshInstance();
    await reserveUnivocityInstance(poolEnv, reserved, "token:ff");
    const res = await post(handlerEnv, reserved);
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("not registered");
  });

  it("challenges with a 402 whose amount is credits x unit price", async () => {
    const { handlerEnv, sent } = creditsEnv();
    const id = freshInstance();
    await completeUnivocityInstanceReservation(poolEnv, id, [], ROOT);

    const res = await post(handlerEnv, id, { credits: "5" });
    expect(res.status).toBe(402);
    const header = res.headers.get("X-PAYMENT-REQUIRED");
    expect(header).toBeTruthy();
    const challenge = JSON.parse(atob(header!)) as {
      accepts: Array<{ amount: string; payTo: string }>;
    };
    expect(challenge.accepts[0]!.amount).toBe("50000");
    expect(challenge.accepts[0]!.payTo).toBe(PAY_TO);
    const body = (await res.json()) as { amountAtomic: string };
    expect(body.amountAtomic).toBe("50000");
    expect(sent).toHaveLength(0);
  });

  it("rejects an out-of-range credits parameter", async () => {
    const { handlerEnv } = creditsEnv();
    const id = freshInstance();
    await completeUnivocityInstanceReservation(poolEnv, id, [], ROOT);
    expect((await post(handlerEnv, id, { credits: "0" })).status).toBe(400);
    expect((await post(handlerEnv, id, { credits: "1000001" })).status).toBe(
      400,
    );
    expect((await post(handlerEnv, id, { credits: "abc" })).status).toBe(400);
  });

  it("accepts a verified payment, claims it once, and enqueues a credits job", async () => {
    stubFacilitatorValid();
    const { handlerEnv, sent } = creditsEnv();
    const id = freshInstance();
    await completeUnivocityInstanceReservation(poolEnv, id, [], ROOT);

    const nonce = `0x${"c1".repeat(16)}`;
    const res = await post(handlerEnv, id, {
      credits: "5",
      payment: paymentHeader("50000", nonce),
    });
    expect(res.status).toBe(202);
    const body = (await res.json()) as {
      credits: number;
      settlement: string;
    };
    expect(body.credits).toBe(5);
    expect(body.settlement).toBe("enqueued");

    expect(sent).toHaveLength(1);
    const job = sent[0]!;
    expect(job.kind).toBe("credits");
    expect(job.univocityInstanceId).toBe(id);
    expect(job.credits).toBe(5);
    expect(job.idempotencyKey).toBe(`credits:${id}:${nonce}`);
    expect(job.amount).toBe("50000");

    // Replay of the same authorization loses the claim: challenged, no job.
    const replay = await post(handlerEnv, id, {
      credits: "5",
      payment: paymentHeader("50000", nonce),
    });
    expect(replay.status).toBe(402);
    const replayBody = (await replay.json()) as { reason?: string };
    expect(replayBody.reason).toContain("already used");
    expect(sent).toHaveLength(1);
  });

  it("rejects an underpaying authorization", async () => {
    stubFacilitatorValid();
    const { handlerEnv, sent } = creditsEnv();
    const id = freshInstance();
    await completeUnivocityInstanceReservation(poolEnv, id, [], ROOT);

    const res = await post(handlerEnv, id, {
      credits: "5",
      payment: paymentHeader("40000", `0x${"c2".repeat(16)}`),
    });
    expect(res.status).toBe(402);
    expect(sent).toHaveLength(0);
  });

  it("stays outside the ops gate while the rest of /api/payments remains gated", async () => {
    const { handlerEnv } = creditsEnv();
    const listRes = await handlePaymentsRequest(
      new Request("https://api.test/api/payments/onboard-tokens"),
      "/api/payments/onboard-tokens",
      handlerEnv,
      {},
    );
    expect(listRes!.status).toBe(401);
  });
});
