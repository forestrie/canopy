/**
 * Self-service onboard request API (FOR-168/169/170/174).
 */

import { decode as decodeCbor, encode as encodeCbor } from "cbor-x";
import { env } from "cloudflare:test";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import worker from "../src/index";
import type { Env } from "../src/index";
import { mintOnboardToken } from "../src/payments/onboard-token-store.js";
import { validGenesisV2Es256CborMap } from "./helpers/genesis-v2-body.js";

const poolEnv = env as unknown as Env;
const OPS = "vitest-ops-admin-token";
const CHAIN = "84532";
const DEPLOYED_ADDR = "a".repeat(40);

const testCtx = {
  waitUntil: (_p: Promise<unknown>) => {},
} as ExecutionContext;

function envWithOnboard(overrides: Partial<Env> = {}): Env {
  return {
    ...poolEnv,
    CANOPY_OPS_ADMIN_TOKEN: OPS,
    ONBOARD_ALLOWED_CHAIN_ID: CHAIN,
    UNIVOCITY_CONTRACT_RPC_URL: "https://rpc.example.invalid",
    ...overrides,
  };
}

function opsHeaders(extra?: Record<string, string>): Record<string, string> {
  return {
    Authorization: `Bearer ${OPS}`,
    "Content-Type": "application/cbor",
    ...extra,
  };
}

function createBody(fields: Record<number, unknown>): Uint8Array {
  const m = new Map<number, unknown>();
  for (const [k, v] of Object.entries(fields)) {
    m.set(Number(k), v);
  }
  return encodeCbor(m) as Uint8Array;
}

describe("onboard request create", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = vi.fn(async (input, init) => {
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      if (body.method === "eth_getCode") {
        return new Response(
          JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x6000" }),
          { status: 200 },
        );
      }
      return originalFetch(input as RequestInfo, init);
    }) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("POST with deployed Univocity returns pending + redeem code", async () => {
    const e = envWithOnboard();
    const res = await worker.fetch(
      new Request("http://localhost/api/onboarding/requests", {
        method: "POST",
        headers: { "Content-Type": "application/cbor" },
        body: createBody({
          1: "fork-a",
          2: CHAIN,
          3: DEPLOYED_ADDR,
          4: "op@example.com",
        }),
      }),
      e,
      testCtx,
    );
    expect(res.status).toBe(201);
    const body = decodeCbor(new Uint8Array(await res.arrayBuffer())) as {
      requestId?: string;
      status?: string;
      redeemCode?: string;
    };
    expect(body.requestId).toBeTruthy();
    expect(body.status).toBe("pending");
    expect(body.redeemCode?.length).toBeGreaterThan(0);
  });

  it("rejects undeployed address", async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(
        JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x" }),
        { status: 200 },
      ),
    ) as typeof fetch;

    const e = envWithOnboard();
    const res = await worker.fetch(
      new Request("http://localhost/api/onboarding/requests", {
        method: "POST",
        headers: { "Content-Type": "application/cbor" },
        body: createBody({
          1: "fork-b",
          2: CHAIN,
          3: DEPLOYED_ADDR,
          4: "op@example.com",
        }),
      }),
      e,
      testCtx,
    );
    expect(res.status).toBe(422);
  });

  it("rejects unsupported chainId", async () => {
    const e = envWithOnboard();
    const res = await worker.fetch(
      new Request("http://localhost/api/onboarding/requests", {
        method: "POST",
        headers: { "Content-Type": "application/cbor" },
        body: createBody({
          1: "fork-c",
          2: "1",
          3: DEPLOYED_ADDR,
          4: "op@example.com",
        }),
      }),
      e,
      testCtx,
    );
    expect(res.status).toBe(400);
  });

  it("GET status omits redeem code", async () => {
    const e = envWithOnboard();
    const createRes = await worker.fetch(
      new Request("http://localhost/api/onboarding/requests", {
        method: "POST",
        headers: { "Content-Type": "application/cbor" },
        body: createBody({
          1: "fork-d",
          2: CHAIN,
          3: DEPLOYED_ADDR,
          4: "op@example.com",
        }),
      }),
      e,
      testCtx,
    );
    const created = decodeCbor(
      new Uint8Array(await createRes.arrayBuffer()),
    ) as { requestId?: string };
    const getRes = await worker.fetch(
      new Request(
        `http://localhost/api/onboarding/requests/${created.requestId}`,
      ),
      e,
      testCtx,
    );
    expect(getRes.status).toBe(200);
    const body = decodeCbor(new Uint8Array(await getRes.arrayBuffer())) as Record<
      string,
      unknown
    >;
    expect(body.redeemCode).toBeUndefined();
  });
});

describe("onboard approve redeem flow", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = vi.fn(async (input, init) => {
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      if (body.method === "eth_getCode") {
        return new Response(
          JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x6000" }),
          { status: 200 },
        );
      }
      return originalFetch(input as RequestInfo, init);
    }) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  async function createApprovedFlow(e: Env) {
    const createRes = await worker.fetch(
      new Request("http://localhost/api/onboarding/requests", {
        method: "POST",
        headers: { "Content-Type": "application/cbor" },
        body: createBody({
          1: "flow-test",
          2: CHAIN,
          3: DEPLOYED_ADDR,
          4: "op@example.com",
        }),
      }),
      e,
      testCtx,
    );
    const created = decodeCbor(
      new Uint8Array(await createRes.arrayBuffer()),
    ) as { requestId?: string; redeemCode?: string };
    await worker.fetch(
      new Request(
        `http://localhost/api/onboarding/requests/${created.requestId}/approve`,
        { method: "POST", headers: opsHeaders() },
      ),
      e,
      testCtx,
    );
    return created;
  }

  it("approve then redeem returns token once", async () => {
    const e = envWithOnboard();
    const { requestId, redeemCode } = await createApprovedFlow(e);

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
    const body = decodeCbor(new Uint8Array(await redeemRes.arrayBuffer())) as {
      token?: string;
    };
    expect(body.token?.length).toBeGreaterThan(0);

    const again = await worker.fetch(
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
    expect(again.status).toBe(409);
  });

  it("invalid redeem code returns 401", async () => {
    const e = envWithOnboard();
    const { requestId } = await createApprovedFlow(e);
    const res = await worker.fetch(
      new Request(
        `http://localhost/api/onboarding/requests/${requestId}/redeem`,
        {
          method: "POST",
          headers: { "Content-Type": "application/cbor" },
          body: createBody({ 1: "bad-code" }),
        },
      ),
      e,
      testCtx,
    );
    expect(res.status).toBe(401);
  });
});

describe("onboard token binding at genesis", () => {
  it("rejects second PA genesis with same token", async () => {
    const e = envWithOnboard();
    const minted = await mintOnboardToken(e, {
      label: "binding-test",
      chainBinding: { chainId: CHAIN, univocityAddr: DEPLOYED_ADDR },
    });

    const rootA = crypto.randomUUID();
    const addrBytes = new Uint8Array(20).fill(0xaa);
    const genesisBody = encodeCbor(
      validGenesisV2Es256CborMap({
        chainId: CHAIN,
        univocityAddr: addrBytes,
      }),
    ) as Uint8Array;

    const first = await worker.fetch(
      new Request(`http://localhost/api/forest/${rootA}/genesis`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${minted.token}`,
          "Content-Type": "application/cbor",
        },
        body: genesisBody,
      }),
      e,
      testCtx,
    );
    expect(first.status).toBe(201);

    const rootB = crypto.randomUUID();
    const second = await worker.fetch(
      new Request(`http://localhost/api/forest/${rootB}/genesis`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${minted.token}`,
          "Content-Type": "application/cbor",
        },
        body: genesisBody,
      }),
      e,
      testCtx,
    );
    expect(second.status).toBe(403);
  });

  it("legacy ops-mint token without binding still works", async () => {
    const e = envWithOnboard();
    const minted = await mintOnboardToken(e, { label: "legacy" });
    const root = crypto.randomUUID();
    const res = await worker.fetch(
      new Request(`http://localhost/api/forest/${root}/genesis`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${minted.token}`,
          "Content-Type": "application/cbor",
        },
        body: encodeCbor(validGenesisV2Es256CborMap()) as Uint8Array,
      }),
      e,
      testCtx,
    );
    expect(res.status).toBe(201);
  });
});
