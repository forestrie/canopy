/**
 * Dual-auth onboard (FOR-434 / FOR-433, plan-2607-38).
 *
 * An onboard token is obtainable by EITHER route:
 *   1. ops action — break-glass mint, or request → ops `approve` → redeem. Free.
 *      This is how a forestrie operator self-onboards its own payment-
 *      authoritative forest, and how partners are onboarded.
 *   2. USDC via x402 — a `pending` request pays at redeem. Self-serve.
 *
 * The load-bearing invariant: **the ops route never charges and never enqueues
 * a settlement** — an operator must not have to pay itself.
 */
import { encodeCborDeterministic } from "@forestrie/encoding";
import { decodeCborAsObject } from "./helpers/cbor-decode-object.js";
import { env } from "cloudflare:test";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import worker from "../src/index";
import type { Env } from "../src/index";
import {
  bootstrapConfigCallData,
  rootLogIdCallData,
} from "../src/onboarding/univocity-identity-probe.js";

const poolEnv = env as unknown as Env;
const OPS = "vitest-ops-admin-token";
const CHAIN = "84532";
const DEPLOYED_ADDR = "a".repeat(40);
const testCtx = { waitUntil: (_p: Promise<unknown>) => {} } as ExecutionContext;
const SUPPORTED_CHAINS_RPC = JSON.stringify({
  [CHAIN]: ["https://rpc.example.invalid"],
});

function createBody(fields: Record<number, unknown>): Uint8Array {
  const m = new Map<number, unknown>();
  for (const [k, v] of Object.entries(fields)) m.set(Number(k), v);
  return encodeCborDeterministic(m);
}

/** ES256 bootstrapConfig() result the Univocity deployment gate accepts. */
function validBootstrapConfigResultHex(): string {
  const alg =
    "fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff9"; // -7 (ES256)
  const offset =
    "0000000000000000000000000000000000000000000000000000000000000040";
  const len =
    "0000000000000000000000000000000000000000000000000000000000000040"; // 64-byte key
  return `0x${alg}${offset}${len}${"00".repeat(64)}`;
}

/** Stub the chain RPC so the onboard deployment gate passes (as sibling tests do). */
function mockUnivocityRpcFetch(originalFetch: typeof fetch) {
  return vi.fn(async (input, init) => {
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    if (body.method === "eth_call") {
      const data = body.params?.[0]?.data as string | undefined;
      if (data === bootstrapConfigCallData()) {
        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            result: validBootstrapConfigResultHex(),
          }),
          { status: 200 },
        );
      }
      if (data === rootLogIdCallData()) {
        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            result: `0x${"00".repeat(32)}`,
          }),
          { status: 200 },
        );
      }
    }
    if (body.method === "eth_getCode") {
      return new Response(
        JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x6000" }),
        { status: 200 },
      );
    }
    return originalFetch(input as RequestInfo, init);
  }) as typeof fetch;
}

const originalFetch = globalThis.fetch;
beforeEach(() => {
  globalThis.fetch = mockUnivocityRpcFetch(originalFetch);
});
afterEach(() => {
  globalThis.fetch = originalFetch;
});

/** Env with a spied settlement queue so we can assert enqueue-or-not. */
function envWith(
  send: ReturnType<typeof vi.fn>,
  overrides: Partial<Env> = {},
): Env {
  return {
    ...poolEnv,
    CANOPY_OPS_ADMIN_TOKEN: OPS,
    SUPPORTED_CHAINS_RPC,
    X402_SETTLEMENT_QUEUE: { send } as unknown as Env["X402_SETTLEMENT_QUEUE"],
    ...overrides,
  } as Env;
}

async function createRequest(e: Env, label: string) {
  const res = await worker.fetch(
    new Request("http://localhost/api/onboarding/requests", {
      method: "POST",
      headers: { "Content-Type": "application/cbor" },
      body: createBody({
        1: label,
        2: CHAIN,
        3: DEPLOYED_ADDR,
        4: "op@example.com",
      }),
    }),
    e,
    testCtx,
  );
  return decodeCborAsObject(new Uint8Array(await res.arrayBuffer())) as {
    requestId?: string;
    redeemCode?: string;
  };
}

async function redeem(e: Env, requestId: string, redeemCode: string) {
  return worker.fetch(
    new Request(
      `http://localhost/api/onboarding/requests/${requestId}/redeem`,
      {
        method: "POST",
        headers: { "Content-Type": "application/cbor" },
        body: createBody({ 1: redeemCode }),
      },
    ),
    e,
    testCtx,
  );
}

describe("dual-auth onboard: ops route stays free (FOR-434)", () => {
  it("an ops-approved request redeems with NO payment and enqueues NO settlement", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const e = envWith(send);

    const { requestId, redeemCode } = await createRequest(e, "partner-onboard");
    // Ops approves — the operator/partner route.
    const approveRes = await worker.fetch(
      new Request(
        `http://localhost/api/onboarding/requests/${requestId}/approve`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${OPS}`,
            "Content-Type": "application/cbor",
          },
        },
      ),
      e,
      testCtx,
    );
    expect(approveRes.status).toBeLessThan(300);

    const res = await redeem(e, requestId!, redeemCode!);
    expect(res.status).toBe(200);

    const body = decodeCborAsObject(
      new Uint8Array(await res.arrayBuffer()),
    ) as {
      token?: string;
    };
    expect(body.token).toBeTruthy();

    // The invariant: no charge, no settlement job. An operator never pays itself.
    expect(send).not.toHaveBeenCalled();
  });
});

describe("dual-auth onboard: unapproved request is offered the paid route", () => {
  it("a pending request redeeming without payment gets 402 + X-PAYMENT-REQUIRED", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    // Auto-approve off so the request stays pending (the self-serve arm).
    const e = envWith(send, { ONBOARD_AUTO_APPROVE: "false" } as Partial<Env>);

    const { requestId, redeemCode } = await createRequest(e, "self-serve");
    const res = await redeem(e, requestId!, redeemCode!);

    // 402 is the desired code (x402 compatibility), replacing the old 409.
    expect(res.status).toBe(402);
    const challenge = res.headers.get("X-PAYMENT-REQUIRED");
    expect(challenge).toBeTruthy();

    // The challenge is base64 JSON describing an `exact` USDC requirement.
    const decoded = JSON.parse(atob(challenge!)) as {
      x402Version: number;
      accepts: Array<{ scheme: string; amount: string; payTo: string }>;
    };
    expect(decoded.x402Version).toBe(2);
    expect(decoded.accepts[0].scheme).toBe("exact");
    expect(decoded.accepts[0].amount).toBe("10000"); // $0.01 default

    // Nothing minted, nothing settled — a failed/absent verify mints none.
    expect(send).not.toHaveBeenCalled();
  });
});
