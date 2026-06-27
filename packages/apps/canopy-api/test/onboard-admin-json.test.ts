/**
 * Ops admin JSON routes for canopy-admin browser UI (FOR-180).
 */

import { decode as decodeCbor, encode as encodeCbor } from "cbor-x";
import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

const testCtx = {
  waitUntil: (_p: Promise<unknown>) => {},
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

function adminJsonHeaders(extra?: Record<string, string>): Record<string, string> {
  return {
    Authorization: `Bearer ${OPS}`,
    "Content-Type": "application/json",
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

describe("onboarding admin JSON routes", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = mockUnivocityRpcFetch(originalFetch);
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  async function createPendingRequest(e: Env, label = "admin-json-test") {
    const createRes = await worker.fetch(
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
    expect(createRes.status).toBe(201);
    const created = decodeCbor(
      new Uint8Array(await createRes.arrayBuffer()),
    ) as { requestId?: string };
    return created.requestId!;
  }

  it("admin approve returns JSON", async () => {
    const e = envWithOnboard({ ONBOARD_AUTO_APPROVE: undefined });
    const requestId = await createPendingRequest(e);

    const res = await worker.fetch(
      new Request(
        `http://localhost/api/onboarding/admin/requests/${requestId}/approve`,
        { method: "POST", headers: adminJsonHeaders() },
      ),
      e,
      testCtx,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    const body = (await res.json()) as { requestId?: string; status?: string };
    expect(body.requestId).toBe(requestId);
    expect(body.status).toBe("approved");
  });

  it("admin reject with JSON reason persists rejectReason", async () => {
    const e = envWithOnboard({ ONBOARD_AUTO_APPROVE: undefined });
    const requestId = await createPendingRequest(e, "reject-json");

    const rejectRes = await worker.fetch(
      new Request(
        `http://localhost/api/onboarding/admin/requests/${requestId}/reject`,
        {
          method: "POST",
          headers: adminJsonHeaders(),
          body: JSON.stringify({ rejectReason: "Unverified operator" }),
        },
      ),
      e,
      testCtx,
    );
    expect(rejectRes.status).toBe(200);
    expect(rejectRes.headers.get("content-type")).toContain("application/json");
    const rejected = (await rejectRes.json()) as {
      requestId?: string;
      status?: string;
    };
    expect(rejected.status).toBe("rejected");

    const listRes = await worker.fetch(
      new Request("http://localhost/api/onboarding/admin/requests", {
        headers: { Authorization: `Bearer ${OPS}` },
      }),
      e,
      testCtx,
    );
    const list = (await listRes.json()) as {
      requests?: Array<{ requestId?: string; rejectReason?: string }>;
    };
    const row = list.requests?.find((r) => r.requestId === requestId);
    expect(row?.rejectReason).toBe("Unverified operator");
  });

  it("CBOR ops approve route still returns CBOR", async () => {
    const e = envWithOnboard({ ONBOARD_AUTO_APPROVE: undefined });
    const requestId = await createPendingRequest(e, "cbor-ops-approve");

    const res = await worker.fetch(
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
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/cbor");
    const body = decodeCbor(new Uint8Array(await res.arrayBuffer())) as {
      status?: string;
    };
    expect(body.status).toBe("approved");
  });
});

describe("CORS preflight for admin UI", () => {
  it("OPTIONS includes PUT in Allow-Methods", async () => {
    const res = await worker.fetch(
      new Request("http://localhost/api/onboarding/admin/requests", {
        method: "OPTIONS",
      }),
      envWithOnboard(),
      testCtx,
    );
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-methods")).toContain("PUT");
  });
});
