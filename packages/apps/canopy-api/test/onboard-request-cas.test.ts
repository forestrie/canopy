/**
 * R2 CAS transitions for pending → approved/rejected (FOR-184).
 */

import { encodeCborDeterministic } from "@forestrie/encoding";
import { decodeCborAsObject } from "./helpers/cbor-decode-object.js";
import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import type { Env } from "../src/index";
import { emitOnboardWebhook } from "../src/onboarding/onboard-notify.js";
import {
  bootstrapConfigCallData,
  rootLogIdCallData,
} from "../src/onboarding/univocity-identity-probe.js";

const poolEnv = env as unknown as Env;
const OPS = "vitest-ops-admin-token";
const CHAIN = "84532";
const DEPLOYED_ADDR = "a".repeat(40);

const testCtx = {
  waitUntil: (p: Promise<unknown>) => {
    void p;
  },
} as ExecutionContext;

const SUPPORTED_CHAINS_RPC = JSON.stringify({
  [CHAIN]: ["https://rpc.example.invalid"],
});

function envWithOnboard(overrides: Partial<Env> = {}): Env {
  return {
    ...poolEnv,
    CANOPY_OPS_ADMIN_TOKEN: OPS,
    SUPPORTED_CHAINS_RPC,
    ...overrides,
  };
}

function createBody(fields: Record<number, unknown>): Uint8Array {
  const m = new Map<number, unknown>();
  for (const [k, v] of Object.entries(fields)) {
    m.set(Number(k), v);
  }
  return encodeCborDeterministic(m);
}

function validBootstrapConfigResultHex(): string {
  const alg =
    "fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff9";
  const offset =
    "0000000000000000000000000000000000000000000000000000000000000040";
  const len =
    "0000000000000000000000000000000000000000000000000000000000000040";
  const key = "00".repeat(64);
  return `0x${alg}${offset}${len}${key}`;
}

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
    return originalFetch(input, init);
  });
}

describe("onboard request CAS transitions", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = mockUnivocityRpcFetch(originalFetch);
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  async function createPendingWithRedeemCode(e: Env) {
    const createRes = await worker.fetch(
      new Request("http://localhost/api/onboarding/requests", {
        method: "POST",
        headers: { "Content-Type": "application/cbor" },
        body: createBody({
          1: "cas-test",
          2: CHAIN,
          3: DEPLOYED_ADDR,
          4: "op@example.com",
        }),
      }),
      e,
      testCtx,
    );
    expect(createRes.status).toBe(201);
    const created = decodeCborAsObject(
      new Uint8Array(await createRes.arrayBuffer()),
    ) as { requestId?: string; redeemCode?: string };
    return {
      requestId: created.requestId!,
      redeemCode: created.redeemCode!,
    };
  }

  it("approve after redeem returns 409 and status stays redeemed", async () => {
    const e = envWithOnboard({ ONBOARD_AUTO_APPROVE: undefined });
    const { requestId, redeemCode } = await createPendingWithRedeemCode(e);

    const approveRes = await worker.fetch(
      new Request(
        `http://localhost/api/onboarding/admin/requests/${requestId}/approve`,
        {
          method: "POST",
          headers: { Authorization: `Bearer ${OPS}` },
        },
      ),
      e,
      testCtx,
    );
    expect(approveRes.status).toBe(200);

    const redeemRes = await worker.fetch(
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
    expect(redeemRes.status).toBe(200);

    const staleApprove = await worker.fetch(
      new Request(
        `http://localhost/api/onboarding/admin/requests/${requestId}/approve`,
        {
          method: "POST",
          headers: { Authorization: `Bearer ${OPS}` },
        },
      ),
      e,
      testCtx,
    );
    expect(staleApprove.status).toBe(409);

    const statusRes = await worker.fetch(
      new Request(`http://localhost/api/onboarding/requests/${requestId}`),
      e,
      testCtx,
    );
    const status = decodeCborAsObject(
      new Uint8Array(await statusRes.arrayBuffer()),
    ) as { status?: string };
    expect(status.status).toBe("redeemed");
  });

  it("parallel approve and reject yields one success and one 409", async () => {
    const e = envWithOnboard({ ONBOARD_AUTO_APPROVE: undefined });
    const { requestId } = await createPendingWithRedeemCode(e);

    const [approveRes, rejectRes] = await Promise.all([
      worker.fetch(
        new Request(
          `http://localhost/api/onboarding/admin/requests/${requestId}/approve`,
          {
            method: "POST",
            headers: { Authorization: `Bearer ${OPS}` },
          },
        ),
        e,
        testCtx,
      ),
      worker.fetch(
        new Request(
          `http://localhost/api/onboarding/admin/requests/${requestId}/reject`,
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${OPS}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ rejectReason: "race" }),
          },
        ),
        e,
        testCtx,
      ),
    ]);

    const statuses = [approveRes.status, rejectRes.status].sort();
    expect(statuses).toEqual([200, 409]);
  });

  it("reject emits onboard.request.rejected webhook", async () => {
    const fetchMock = vi.fn<typeof fetch>(
      async () => new Response("ok", { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await emitOnboardWebhook(
      {
        ONBOARD_REQUEST_WEBHOOK_URL: "https://hooks.example/notify",
        ONBOARD_REQUEST_WEBHOOK_SECRET: "test-secret",
      },
      "onboard.request.rejected",
      { requestId: "req-reject", rejectReason: "policy" },
    );

    expect(fetchMock).toHaveBeenCalledOnce();
    const body = JSON.parse(String(fetchMock.mock.calls[0]![1]!.body)) as {
      event?: string;
      requestId?: string;
      rejectReason?: string;
    };
    expect(body.event).toBe("onboard.request.rejected");
    expect(body.rejectReason).toBe("policy");
  });
});
