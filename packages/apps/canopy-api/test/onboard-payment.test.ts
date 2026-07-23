import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { SettlementJob } from "@canopy/x402-settlement-types";
import type { VerifiedPayment } from "../src/scrapi/verified-payment.js";
import {
  buildOnboardSettlementJob,
  enqueueOnboardSettlement,
} from "../src/onboarding/onboard-payment.js";

const NONCE = "0xabc123";

function fixturePayment(): VerifiedPayment {
  return {
    scheme: "exact",
    network: "eip155:84532",
    payTo: "0x75be7950F26fe7F15336a10b33A8D8134faDb787",
    payerAddress: "0x0c552c20eee6644112b4965ff70f929c4ab80d4b",
    amount: "10000",
    payload: {
      x402Version: 2,
      payload: {
        signature: "0xsig",
        authorization: {
          from: "0x0c552c20eee6644112b4965ff70f929c4ab80d4b",
          to: "0x75be7950F26fe7F15336a10b33A8D8134faDb787",
          value: "10000",
          validAfter: "0",
          validBefore: "9999999999",
          nonce: NONCE,
        },
      },
      resource: { url: "https://x/redeem", mimeType: "application/json" },
      accepted: {
        scheme: "exact",
        network: "eip155:84532",
        amount: "10000",
        asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
        payTo: "0x75be7950F26fe7F15336a10b33A8D8134faDb787",
      },
    },
  };
}

describe("buildOnboardSettlementJob (FOR-434 contract)", () => {
  it("derives the onboard idempotencyKey and kind, omitting statement fields", () => {
    const job = buildOnboardSettlementJob({
      payment: fixturePayment(),
      authId: "local:0x0c55",
      requestId: "req-42",
      now: 1_700_000_000_000,
    });

    expect(job.kind).toBe("onboard");
    expect(job.scheme).toBe("exact");
    expect(job.idempotencyKey).toBe(`onboard:req-42:${NONCE}`);
    expect(job.requestId).toBe("req-42");
    expect(job.payer).toBe("0x0c552c20eee6644112b4965ff70f929c4ab80d4b");
    expect(job.amount).toBe("10000");
    expect(job.createdAt).toBe(1_700_000_000_000);
    // onboardTokenRef is filled in by the caller after the token mints.
    expect(job.onboardTokenRef).toBeUndefined();
    // Statement-shaped fields do not apply to onboard.
    expect(job.logId).toBeUndefined();
    expect(job.contentHash).toBeUndefined();
    // Full payment payload is carried for the worker to settle.
    expect(job.payload.payload.authorization.nonce).toBe(NONCE);
  });

  it("produces a distinct idempotencyKey per (request, payment nonce)", () => {
    const p = fixturePayment();
    const a = buildOnboardSettlementJob({
      payment: p,
      authId: "x",
      requestId: "r1",
      now: 1,
    });
    const p2 = fixturePayment();
    p2.payload.payload.authorization.nonce = "0xdifferent";
    const b = buildOnboardSettlementJob({
      payment: p2,
      authId: "x",
      requestId: "r1",
      now: 1,
    });
    expect(a.idempotencyKey).not.toBe(b.idempotencyKey);
  });
});

describe("enqueueOnboardSettlement (binding-optional guard, mint-on-verify)", () => {
  let errSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => errSpy.mockRestore());

  const job = { idempotencyKey: "onboard:r:1" } as SettlementJob;

  it("sends the job when the queue is bound", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    await enqueueOnboardSettlement(
      { X402_SETTLEMENT_QUEUE: { send } as unknown as Queue<SettlementJob> },
      job,
    );
    expect(send).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledWith(job);
    expect(errSpy).not.toHaveBeenCalled();
  });

  it("does not throw and logs when the queue is unbound", async () => {
    await expect(enqueueOnboardSettlement({}, job)).resolves.toBeUndefined();
    expect(errSpy).toHaveBeenCalledOnce();
    expect(String(errSpy.mock.calls[0][0])).toContain("unbound");
  });

  it("does not throw and logs when send fails (token already minted)", async () => {
    const send = vi.fn().mockRejectedValue(new Error("queue down"));
    await expect(
      enqueueOnboardSettlement(
        { X402_SETTLEMENT_QUEUE: { send } as unknown as Queue<SettlementJob> },
        job,
      ),
    ).resolves.toBeUndefined();
    expect(errSpy).toHaveBeenCalledOnce();
    expect(String(errSpy.mock.calls[0][0])).toContain("enqueue failed");
  });
});
