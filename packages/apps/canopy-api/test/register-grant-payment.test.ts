/**
 * register-grant x402 payment gate (plan-2608-09 W2). A parent grant carrying
 * GF_DERIVED | GF_CHILD_PAYMENT_REQUIRED (adr-0062) makes child-grant
 * registration payment-gated. Exercises the gate matrix directly against the
 * shared onboard/credits x402 machinery (worker pool R2 for the claim, a
 * fetch-mocked facilitator).
 */
import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SettlementJob } from "@canopy/x402-settlement-types";
import {
  enforceRegisterGrantPayment,
  parseRegisterGrantAdmission,
  type RegisterGrantPaymentEnv,
} from "../src/scrapi/register-grant-payment.js";
import { withChildPaymentRequired } from "../src/grant/grant-flags.js";
import type { Grant, GrantResult } from "../src/grant/types.js";
import type { ParsedForestGenesis } from "../src/forest/parsed-forest-genesis.js";
import type { Env } from "../src/index";

const poolEnv = env as unknown as Env;

const PAY_TO = "0x75be7950F26fe7F15336a10b33A8D8134faDb787";
const USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const OPS_TOKEN = "vitest-ops-admin-token";
const REGISTER_URL = "https://api.test/register/rrrrrrrr/grants";

/** Shared 16-byte owner/authority log id — parent.logId must equal child.ownerLogId. */
const OWNER = new Uint8Array(16).fill(0xa1);
const OTHER = new Uint8Array(16).fill(0xb2);

function gateEnv(overrides: Record<string, unknown> = {}): {
  gateEnv: RegisterGrantPaymentEnv;
  sent: SettlementJob[];
} {
  const sent: SettlementJob[] = [];
  const built = {
    ...poolEnv,
    CANOPY_OPS_ADMIN_TOKEN: OPS_TOKEN,
    X402_NETWORK: "eip155:84532",
    X402_PAYTO_ADDRESS: PAY_TO,
    REGISTER_GRANT_PRICE_ATOMIC: "10000",
    X402_FACILITATOR_URL: "https://facilitator.invalid",
    X402_SETTLEMENT_QUEUE: {
      send: async (job: SettlementJob) => {
        sent.push(job);
      },
    },
    ...overrides,
  } as unknown as RegisterGrantPaymentEnv;
  return { gateEnv: built, sent };
}

/** A parent GrantResult; `withBit` sets GF_DERIVED | GF_CHILD_PAYMENT_REQUIRED. */
function parentGrant(logId: Uint8Array, flags: Uint8Array): GrantResult {
  return {
    grant: { logId, grant: flags, ownerLogId: logId } as Grant,
  } as GrantResult;
}

/** A child grant under `ownerLogId` bounded to `maxHeight`. */
function childGrant(
  ownerLogId: Uint8Array,
  maxHeight: number | undefined,
): Grant {
  return {
    logId: new Uint8Array(16).fill(0xcc),
    grant: new Uint8Array([0, 0, 0, 0x03, 0, 0, 0, 0x01]), // create+extend, auth-log
    ownerLogId,
    ...(maxHeight === undefined ? {} : { maxHeight }),
    grantData: new Uint8Array(0),
  } as Grant;
}

function genesis(): ParsedForestGenesis {
  return {
    wire: new Uint8Array(16).fill(0x0f),
    schemaVersion: 2,
    chainBinding: { address: new Uint8Array(20).fill(0x11), chainId: "84532" },
  } as ParsedForestGenesis;
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
      resource: { url: REGISTER_URL, mimeType: "application/cbor" },
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

function req(headers: Record<string, string> = {}): Request {
  return new Request(REGISTER_URL, { method: "POST", headers });
}

async function runGate(
  gateE: RegisterGrantPaymentEnv,
  opts: {
    parentFlags: Uint8Array | null;
    parentLogId?: Uint8Array;
    maxHeight?: number;
    headers?: Record<string, string>;
    targetLogUuid?: string;
  },
): Promise<Response | null> {
  const parent =
    opts.parentFlags === null
      ? null
      : parentGrant(opts.parentLogId ?? OWNER, opts.parentFlags);
  const maxHeight = "maxHeight" in opts ? opts.maxHeight : 5;
  return enforceRegisterGrantPayment({
    request: req(opts.headers),
    env: gateE,
    childGrant: childGrant(OWNER, maxHeight),
    parentGrant: parent,
    genesis: genesis(),
    targetLogUuid: opts.targetLogUuid ?? "11111111-1111-4111-8111-111111111111",
  });
}

const withBit = () => withChildPaymentRequired(new Uint8Array(8));
const derivedOnly = () => {
  const g = new Uint8Array(8);
  g[3] = 0x04; // GF_DERIVED, no payment bit
  return g;
};

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

describe("parseRegisterGrantAdmission", () => {
  it("defaults to open and maps the known values; rejects the unknown", () => {
    expect(parseRegisterGrantAdmission(undefined)).toBe("open");
    expect(parseRegisterGrantAdmission("")).toBe("open");
    expect(parseRegisterGrantAdmission("open")).toBe("open");
    expect(parseRegisterGrantAdmission(" PAID ")).toBe("paid");
    expect(parseRegisterGrantAdmission("either")).toBe("either");
    expect(parseRegisterGrantAdmission("bogus")).toBe("invalid");
  });
});

describe("register-grant payment gate", () => {
  it("no gate when the parent carries no payment bit (absent, and GF_DERIVED-only)", async () => {
    const { gateEnv: e, sent } = gateEnv();
    expect(await runGate(e, { parentFlags: new Uint8Array(8) })).toBeNull();
    expect(await runGate(e, { parentFlags: derivedOnly() })).toBeNull();
    // Even a missing parent (no evidence in the body) → no policy → no gate.
    expect(await runGate(e, { parentFlags: null })).toBeNull();
    expect(sent).toHaveLength(0);
  });

  it("no gate when the payment-required parent is not this child's authority", async () => {
    const { gateEnv: e, sent } = gateEnv();
    // Parent carries the bit but its logId != child.ownerLogId (OWNER): incoherent, ignored.
    const res = await runGate(e, {
      parentFlags: withBit(),
      parentLogId: OTHER,
    });
    expect(res).toBeNull();
    expect(sent).toHaveLength(0);
  });

  it("402 challenge (amount = price x maxHeight) when the bit is present and no payment", async () => {
    const { gateEnv: e, sent } = gateEnv();
    const res = await runGate(e, { parentFlags: withBit(), maxHeight: 5 });
    expect(res).not.toBeNull();
    expect(res!.status).toBe(402);
    const header = res!.headers.get("X-PAYMENT-REQUIRED");
    expect(header).toBeTruthy();
    const challenge = JSON.parse(atob(header!)) as {
      accepts: Array<{ amount: string; payTo: string }>;
    };
    expect(challenge.accepts[0]!.amount).toBe("50000"); // 10000 x 5
    expect(challenge.accepts[0]!.payTo).toBe(PAY_TO);
    expect(sent).toHaveLength(0);
  });

  it("400 when a payment-required child declares no positive maxHeight", async () => {
    const { gateEnv: e } = gateEnv();
    expect(
      (await runGate(e, { parentFlags: withBit(), maxHeight: 0 }))!.status,
    ).toBe(400);
    expect(
      (await runGate(e, { parentFlags: withBit(), maxHeight: undefined }))!
        .status,
    ).toBe(400);
  });

  it("500 when the gate is on but REGISTER_GRANT_PRICE_ATOMIC is unset", async () => {
    const { gateEnv: e } = gateEnv({ REGISTER_GRANT_PRICE_ATOMIC: undefined });
    const res = await runGate(e, { parentFlags: withBit() });
    expect(res!.status).toBe(500);
  });

  it("accepts a valid payment, enqueues a kind:grant job, and rejects the replay", async () => {
    stubFacilitatorValid();
    const { gateEnv: e, sent } = gateEnv();
    const nonce = `0x${"a7".repeat(16)}`;
    const targetLogUuid = "22222222-2222-4222-8222-222222222222";

    const res = await runGate(e, {
      parentFlags: withBit(),
      maxHeight: 5,
      targetLogUuid,
      headers: { "X-PAYMENT": paymentHeader("50000", nonce) },
    });
    expect(res).toBeNull(); // proceed to enqueue the grant
    expect(sent).toHaveLength(1);
    const job = sent[0]!;
    expect(job.kind).toBe("grant");
    expect(job.logId).toBe(targetLogUuid);
    expect(job.idempotencyKey).toBe(`grant:${targetLogUuid}:${nonce}`);
    expect(job.amount).toBe("50000");
    expect(job.univocityInstanceId).toBe(
      "eip155:84532:0x1111111111111111111111111111111111111111",
    );

    // Replay of the same authorization loses the claim → 402, no second job.
    const replay = await runGate(e, {
      parentFlags: withBit(),
      maxHeight: 5,
      targetLogUuid,
      headers: { "X-PAYMENT": paymentHeader("50000", nonce) },
    });
    expect(replay!.status).toBe(402);
    expect(sent).toHaveLength(1);
  });

  it("rejects an underpaying authorization (local amount assertion)", async () => {
    stubFacilitatorValid();
    const { gateEnv: e, sent } = gateEnv();
    const res = await runGate(e, {
      parentFlags: withBit(),
      maxHeight: 5,
      headers: { "X-PAYMENT": paymentHeader("40000", `0x${"a8".repeat(16)}`) },
    });
    expect(res!.status).toBe(402);
    expect(sent).toHaveLength(0);
  });

  it("ops bearer bypasses the gate without payment", async () => {
    const { gateEnv: e, sent } = gateEnv();
    const res = await runGate(e, {
      parentFlags: withBit(),
      headers: { "X-Ops-Authorization": `Bearer ${OPS_TOKEN}` },
    });
    expect(res).toBeNull();
    expect(sent).toHaveLength(0);
  });

  it("a wrong ops bearer does NOT bypass (still challenged)", async () => {
    const { gateEnv: e } = gateEnv();
    const res = await runGate(e, {
      parentFlags: withBit(),
      headers: { "X-Ops-Authorization": "Bearer not-the-token" },
    });
    expect(res!.status).toBe(402);
  });
});
