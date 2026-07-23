/**
 * Security guards on the paid onboard path (review remediation, FOR-441/442).
 *
 * R1/FOR-441 — a payment authorization is single-use. Verify is stateless: the
 *   same unspent authorization verifies for every concurrent request until
 *   settlement lands, so without a claim one payment mints one token per
 *   onboard request. Demonstrated live before this fix.
 * R2/FOR-442 — X402_MODE must not be able to disable verification.
 * R3 — underpayment is rejected locally, not just by the facilitator.
 * R4 — a failed enqueue persists a receivable, not just a log line.
 */
import { env } from "cloudflare:test";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import type { Env } from "../src/index";
import type { VerifiedPayment } from "../src/scrapi/verified-payment.js";
import type { SettlementJob } from "@canopy/x402-settlement-types";
import { getPaymentRequirementsForVerify } from "../src/scrapi/x402.js";
import {
  claimPaymentAuthorization,
  verifyOnboardPayment,
  enqueueOnboardSettlement,
} from "../src/onboarding/onboard-payment.js";

const poolEnv = env as unknown as Env;
const PAY_TO = "0x75be7950F26fe7F15336a10b33A8D8134faDb787";
const USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";

function payment(nonce: string, amount = "10000"): VerifiedPayment {
  return {
    scheme: "exact",
    network: "eip155:84532",
    payTo: PAY_TO,
    payerAddress: "0x0c552c20eee6644112b4965ff70f929c4ab80d4b",
    amount,
    payload: {
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
      resource: { url: "https://x/redeem", mimeType: "application/json" },
      accepted: {
        scheme: "exact",
        network: "eip155:84532",
        amount: "10000",
        asset: USDC,
        payTo: PAY_TO,
      },
    },
  };
}

function paymentEnv(overrides: Record<string, unknown> = {}) {
  return {
    R2_GRANTS: poolEnv.R2_GRANTS,
    X402_NETWORK: "eip155:84532",
    X402_PAYTO_ADDRESS: PAY_TO,
    X402_ONBOARD_PRICE_ATOMIC: "10000",
    X402_FACILITATOR_URL: "https://facilitator.invalid",
    ...overrides,
  } as Parameters<typeof claimPaymentAuthorization>[0];
}

describe("R1/FOR-441: payment authorization is single-use", () => {
  it("the first claim wins and a replay of the same authorization loses", async () => {
    const e = paymentEnv();
    const p = payment(`0x${"a1".repeat(16)}`);

    // Same authorization, two different onboard requests — the exact shape of
    // the demonstrated exploit.
    const first = await claimPaymentAuthorization(e, p, "request-A");
    const second = await claimPaymentAuthorization(e, p, "request-B");

    expect(first).toBe(true);
    expect(second).toBe(false); // <- without the claim this was `true`, minting a 2nd token
  });

  it("persists validBefore on the claim so RM6 pruning stays implementable", async () => {
    const e = paymentEnv();
    const p = payment(`0x${"a7".repeat(16)}`);
    expect(await claimPaymentAuthorization(e, p, "req-ttl")).toBe(true);

    // The claim key is derived internally; find the single record we just wrote.
    const listed = await poolEnv.R2_GRANTS.list({
      prefix: "payments/used-auth/",
    });
    const objs = await Promise.all(
      listed.objects.map(async (o) => ({
        key: o.key,
        rec: JSON.parse(await (await poolEnv.R2_GRANTS.get(o.key))!.text()) as {
          nonce: string;
          validBefore?: string;
        },
      })),
    );
    const mine = objs.find(
      (o) => o.rec.nonce === p.payload.payload.authorization.nonce,
    );
    expect(mine).toBeDefined();
    // Pruning at validBefore is the safe boundary — without this field a sweep
    // has nothing to prune on.
    expect(mine!.rec.validBefore).toBe("9999999999");
  });

  it("a different authorization (new nonce) is independently claimable", async () => {
    const e = paymentEnv();
    expect(
      await claimPaymentAuthorization(e, payment(`0x${"b2".repeat(16)}`), "r1"),
    ).toBe(true);
    expect(
      await claimPaymentAuthorization(e, payment(`0x${"c3".repeat(16)}`), "r2"),
    ).toBe(true);
  });

  it("claiming is idempotent for the same request (a retry does not resurrect it)", async () => {
    const e = paymentEnv();
    const p = payment(`0x${"d4".repeat(16)}`);
    expect(await claimPaymentAuthorization(e, p, "same")).toBe(true);
    expect(await claimPaymentAuthorization(e, p, "same")).toBe(false);
  });
});

describe("RM6: claim-expiry safety coupling", () => {
  it("maxTimeoutSeconds stays far below the 1-day R2 lifecycle window", () => {
    // The lifecycle rule (task cloudflare:bucket:lifecycle:used-auth) expires
    // payments/used-auth/ objects 1 day after creation. That is only safe while
    // a claim's guarded authorization dies well within that day: a claim written
    // at T guards an authorization whose validBefore <= T + maxTimeoutSeconds.
    // If maxTimeoutSeconds ever approaches 1 day, expiring claims could permit
    // a replay of a still-settleable authorization.
    const LIFECYCLE_WINDOW_SECONDS = 24 * 60 * 60;
    const maxTimeoutSeconds =
      getPaymentRequirementsForVerify("https://x/redeem", {})
        .maxTimeoutSeconds ?? 0;

    expect(maxTimeoutSeconds).toBeGreaterThan(0);
    // Keep at least an order of magnitude of headroom.
    expect(maxTimeoutSeconds * 10).toBeLessThan(LIFECYCLE_WINDOW_SECONDS);
  });
});

describe("R2/FOR-442: X402_MODE cannot disable verification", () => {
  it("verify-only still performs an authoritative facilitator verify", async () => {
    const e = paymentEnv({ X402_MODE: "verify-only" });
    // Facilitator unreachable -> must fail closed, NOT return a free pass.
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("nope", { status: 500 }));
    try {
      const req = new Request("https://x/redeem", {
        headers: {
          "X-PAYMENT": btoa(
            JSON.stringify(payment(`0x${"e5".repeat(16)}`).payload),
          ),
        },
      });
      const out = await verifyOnboardPayment(req, e, "https://x/redeem");
      expect(out.status).not.toBe("paid");
      // It must have actually called the facilitator rather than short-circuiting.
      expect(fetchSpy).toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });
});

describe("R3: underpayment is rejected locally", () => {
  it("rejects a payment signed for less than the required price, without a facilitator call", async () => {
    const e = paymentEnv();
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    try {
      const under = payment(`0x${"f6".repeat(16)}`, "1"); // 1 atomic unit vs 10000
      const req = new Request("https://x/redeem", {
        headers: { "X-PAYMENT": btoa(JSON.stringify(under.payload)) },
      });
      const out = await verifyOnboardPayment(req, e, "https://x/redeem");
      expect(out.status).toBe("invalid");
      if (out.status === "invalid") expect(out.reason).toMatch(/underpay/i);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });
});

describe("R4: a failed enqueue persists a receivable", () => {
  let errSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => errSpy.mockRestore());

  it("writes an unsettled record when the queue is unbound", async () => {
    const e = paymentEnv();
    const job = {
      idempotencyKey: "onboard:req-unsettled:0xnonce",
      jobId: "j1",
      kind: "onboard",
      authId: "local:0x0c55",
      scheme: "exact",
      payer: "0x0c552c20eee6644112b4965ff70f929c4ab80d4b",
      amount: "10000",
      createdAt: 1,
      payload: payment("0x00").payload,
    } as SettlementJob;

    await enqueueOnboardSettlement(e, job);

    const rec = await poolEnv.R2_GRANTS.get(
      `payments/unsettled/${job.idempotencyKey}`,
    );
    expect(rec).not.toBeNull();
    const stored = JSON.parse(await rec!.text()) as {
      amount: string;
      reason: string;
    };
    expect(stored.amount).toBe("10000");
    expect(stored.reason).toMatch(/unbound/i);
  });
});
