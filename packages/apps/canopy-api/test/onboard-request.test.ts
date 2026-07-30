/**
 * Self-service onboard request API (FOR-168/169/170/174 + hardening).
 */

import { encodeCborDeterministic } from "@forestrie/encoding";
import { decodeCborAsObject } from "./helpers/cbor-decode-object.js";
import { env } from "cloudflare:test";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import worker from "../src/index";
import type { Env } from "../src/index";
import {
  listOnboardTokens,
  mintOnboardToken,
  readOnboardTokenRecord,
} from "../src/payments/onboard-token-store.js";
import {
  hashOnboardToken,
  onboardTokenR2Key,
} from "../src/payments/onboard-token-hash.js";
import { onboardRequestR2Key } from "../src/onboarding/onboard-request-hash.js";
import { readOnboardRequest } from "../src/onboarding/onboard-request-store.js";
import {
  seedGenesisChainIdentity,
  validGenesisV2Es256CborMap,
} from "./helpers/genesis-v2-body.js";
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

function invalidBootstrapConfigResultHex(): string {
  const alg =
    "0000000000000000000000000000000000000000000000000000000000000000";
  const offset =
    "0000000000000000000000000000000000000000000000000000000000000040";
  const len =
    "0000000000000000000000000000000000000000000000000000000000000004";
  const key = "00000000";
  return `0x${alg}${offset}${len}${key}`;
}

function mockUnivocityRpcFetch(
  originalFetch: typeof fetch,
  bootstrapResult = validBootstrapConfigResultHex(),
) {
  return vi.fn(async (input, init) => {
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    if (body.method === "eth_call") {
      const data = body.params?.[0]?.data as string | undefined;
      if (data === bootstrapConfigCallData()) {
        return new Response(
          JSON.stringify({ jsonrpc: "2.0", id: 1, result: bootstrapResult }),
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

describe("onboard request create", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = mockUnivocityRpcFetch(originalFetch);
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
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = decodeCborAsObject(
      new Uint8Array(await res.arrayBuffer()),
    ) as {
      requestId?: string;
      status?: string;
      redeemCode?: string;
    };
    expect(body.requestId).toBeTruthy();
    expect(body.status).toBe("pending");
    expect(body.redeemCode?.length).toBeGreaterThan(0);
  });

  it("rejects non-Univocity contract (invalid bootstrapConfig)", async () => {
    globalThis.fetch = mockUnivocityRpcFetch(
      originalFetch,
      invalidBootstrapConfigResultHex(),
    );

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

  it("returns 429 when create rate limit exceeded", async () => {
    const e = envWithOnboard({
      ONBOARD_CREATE_RATE_LIMITER: {
        limit: async () => ({ success: false }),
      },
    });
    const res = await worker.fetch(
      new Request("http://localhost/api/onboarding/requests", {
        method: "POST",
        headers: { "Content-Type": "application/cbor" },
        body: createBody({
          1: "rate-limited",
          2: CHAIN,
          3: DEPLOYED_ADDR,
          4: "op@example.com",
        }),
      }),
      e,
      testCtx,
    );
    expect(res.status).toBe(429);
  });

  it("GET status omits redeem code and sends no-store", async () => {
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
    const created = decodeCborAsObject(
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
    expect(getRes.headers.get("cache-control")).toBe("no-store");
    const body = decodeCborAsObject(
      new Uint8Array(await getRes.arrayBuffer()),
    ) as Record<string, unknown>;
    expect(body.redeemCode).toBeUndefined();
  });
});

describe("onboard approve redeem flow", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = mockUnivocityRpcFetch(originalFetch);
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  async function createApprovedFlow(e: Env, label = "flow-test") {
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
    const created = decodeCborAsObject(
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

  it("approve then redeem returns token once with no-store", async () => {
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
    expect(redeemRes.headers.get("cache-control")).toBe("no-store");
    const body = decodeCborAsObject(
      new Uint8Array(await redeemRes.arrayBuffer()),
    ) as {
      token?: string;
    };
    expect(body.token?.length).toBeGreaterThan(0);

    // Idempotent re-redeem (plan-2607-46 slice 02): the same redeemCode on a
    // redeemed request re-issues a FRESH token (never 409, never a payment),
    // and the previous ref is revoked — at most one active token per request.
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
    expect(again.status).toBe(200);
    const reissued = decodeCborAsObject(
      new Uint8Array(await again.arrayBuffer()),
    ) as { token?: string; ref?: string };
    expect(reissued.token?.length).toBeGreaterThan(0);
    expect(reissued.token).not.toBe(body.token);

    const firstHash = await hashOnboardToken(body.token!);
    const firstRecord = await readOnboardTokenRecord(e, firstHash);
    expect(firstRecord?.status).toBe("revoked");
    const reissuedRecord = await readOnboardTokenRecord(e, reissued.ref!);
    expect(reissuedRecord?.status).toBe("active");

    // A wrong redeemCode still never re-issues.
    const wrongCode = await worker.fetch(
      new Request(
        `http://localhost/api/onboarding/requests/${requestId}/redeem`,
        {
          method: "POST",
          headers: { "Content-Type": "application/cbor" },
          body: createBody({ 1: "00".repeat(32) }),
        },
      ),
      e,
      testCtx,
    );
    expect(wrongCode.status).toBe(401);
  });

  it("concurrent re-redeems leave exactly one active token (plan-2607-10 R1)", async () => {
    const e = envWithOnboard();
    const { requestId, redeemCode } = await createApprovedFlow(
      e,
      "concurrent-reissue",
    );
    const redeem = () =>
      worker.fetch(
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
    expect((await redeem()).status).toBe(200);

    const [a, b] = await Promise.all([redeem(), redeem()]);
    // Both may win via server-side retry, or one may report contention.
    expect([200, 409]).toContain(a.status);
    expect([200, 409]).toContain(b.status);

    const tokens = (await listOnboardTokens(e)).filter(
      (t) => t.requestId === requestId,
    );
    const active = tokens.filter((t) => t.status === "active");
    expect(active).toHaveLength(1);
    const record = await readOnboardRequest(e, requestId!);
    expect(record?.onboardTokenRef).toBe(active[0]!.hash);
  });

  it("re-redeem sweeps orphaned active tokens from earlier crashes (plan-2607-10 R1)", async () => {
    const e = envWithOnboard();
    const { requestId, redeemCode } = await createApprovedFlow(
      e,
      "orphan-sweep",
    );
    const redeem = () =>
      worker.fetch(
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
    expect((await redeem()).status).toBe(200);

    // Simulate a crashed reissue: an active token minted for this request
    // that no record ref points at.
    const orphan = await mintOnboardToken(e, {
      label: "orphan",
      requestId: requestId!,
      chainBinding: { chainId: CHAIN, univocityAddr: DEPLOYED_ADDR },
    });

    expect((await redeem()).status).toBe(200);
    const orphanAfter = await readOnboardTokenRecord(e, orphan.record.hash);
    expect(orphanAfter?.status).toBe("revoked");
    const active = (await listOnboardTokens(e)).filter(
      (t) => t.requestId === requestId && t.status === "active",
    );
    expect(active).toHaveLength(1);
  });

  it("re-redeem never demands payment under paid admission", async () => {
    // Admission was recorded at first redeem and any x402 authorization was
    // claim-burned before the redeemed transition — a 402 on re-redeem would
    // double-charge (plan-2607-46 slice 02).
    const e = envWithOnboard({ ONBOARD_ADMISSION: "paid" } as Partial<Env>);
    const { requestId, redeemCode } = await createApprovedFlow(
      e,
      "paid-reissue",
    );
    const redeem = () =>
      worker.fetch(
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
    expect((await redeem()).status).toBe(200);
    const again = await redeem();
    expect(again.status).toBe(200);
  });

  it("re-redeem of an expired redeemed request returns 410", async () => {
    const e = envWithOnboard();
    const { requestId, redeemCode } = await createApprovedFlow(
      e,
      "expired-reissue",
    );
    const redeem = () =>
      worker.fetch(
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
    expect((await redeem()).status).toBe(200);

    // Force the request past its expiry; a redeemed record never expires via
    // effectiveStatus, so the re-redeem branch checks the window explicitly.
    const key = onboardRequestR2Key(requestId!);
    const raw = await e.R2_GRANTS.get(key);
    const record = JSON.parse(await raw!.text()) as { expiresAt: number };
    record.expiresAt = Math.floor(Date.now() / 1000) - 10;
    await e.R2_GRANTS.put(key, JSON.stringify(record), {
      httpMetadata: { contentType: "application/json" },
    });

    expect((await redeem()).status).toBe(410);
  });

  it("parallel redeem: only one caller receives token", async () => {
    const e = envWithOnboard();
    const { requestId, redeemCode } = await createApprovedFlow(
      e,
      "parallel-redeem",
    );

    const redeemReq = () =>
      worker.fetch(
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

    const [a, b] = await Promise.all([redeemReq(), redeemReq()]);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([200, 409]);
  });

  it("rejects ops approve without bearer", async () => {
    const e = envWithOnboard();
    const createRes = await worker.fetch(
      new Request("http://localhost/api/onboarding/requests", {
        method: "POST",
        headers: { "Content-Type": "application/cbor" },
        body: createBody({
          1: "ops-auth",
          2: CHAIN,
          3: DEPLOYED_ADDR,
          4: "op@example.com",
        }),
      }),
      e,
      testCtx,
    );
    const created = decodeCborAsObject(
      new Uint8Array(await createRes.arrayBuffer()),
    ) as { requestId?: string };
    const res = await worker.fetch(
      new Request(
        `http://localhost/api/onboarding/requests/${created.requestId}/approve`,
        { method: "POST" },
      ),
      e,
      testCtx,
    );
    expect(res.status).toBe(401);
  });

  it("returns 409 when redeeming rejected request", async () => {
    const e = envWithOnboard();
    const createRes = await worker.fetch(
      new Request("http://localhost/api/onboarding/requests", {
        method: "POST",
        headers: { "Content-Type": "application/cbor" },
        body: createBody({
          1: "reject-flow",
          2: CHAIN,
          3: DEPLOYED_ADDR,
          4: "op@example.com",
        }),
      }),
      e,
      testCtx,
    );
    const created = decodeCborAsObject(
      new Uint8Array(await createRes.arrayBuffer()),
    ) as { requestId?: string; redeemCode?: string };
    await worker.fetch(
      new Request(
        `http://localhost/api/onboarding/requests/${created.requestId}/reject`,
        { method: "POST", headers: opsHeaders() },
      ),
      e,
      testCtx,
    );
    const res = await worker.fetch(
      new Request(
        `http://localhost/api/onboarding/requests/${created.requestId}/redeem`,
        {
          method: "POST",
          headers: { "Content-Type": "application/cbor" },
          body: createBody({ 1: created.redeemCode }),
        },
      ),
      e,
      testCtx,
    );
    expect(res.status).toBe(409);
  });

  it("returns 410 when redeeming expired approved request", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    try {
      const e = envWithOnboard({ ONBOARD_REQUEST_TTL_SEC: "3600" });
      const { requestId, redeemCode } = await createApprovedFlow(e, "expired");
      vi.setSystemTime(new Date("2026-01-01T02:00:00Z"));
      const res = await worker.fetch(
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
      expect(res.status).toBe(410);
    } finally {
      vi.useRealTimers();
    }
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

  it("approved request has no onboardTokenRef until redeem", async () => {
    const e = envWithOnboard();
    const { requestId } = await createApprovedFlow(e, "no-ref-until-redeem");
    const getRes = await worker.fetch(
      new Request(`http://localhost/api/onboarding/requests/${requestId}`),
      e,
      testCtx,
    );
    const body = decodeCborAsObject(
      new Uint8Array(await getRes.arrayBuffer()),
    ) as {
      status?: string;
      onboardTokenRef?: string;
    };
    expect(body.status).toBe("approved");
    expect(body.onboardTokenRef).toBeUndefined();
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
    const genesisMap = validGenesisV2Es256CborMap({
      chainId: CHAIN,
      univocityAddr: addrBytes,
    });
    await seedGenesisChainIdentity(e, genesisMap);
    const genesisBody = encodeCborDeterministic(genesisMap) as Uint8Array;

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
    // Same token, different R: the auth-stage consumedForestR check fires
    // before any reservation logic, so this stays the token-consumed 403.
    // (A *different* token contesting the instance gets the 409 — see
    // payments-registration.test.ts.)
    expect(second.status).toBe(403);
  });

  it("parallel genesis with same token: only one forest registers", async () => {
    const e = envWithOnboard();
    const minted = await mintOnboardToken(e, {
      label: "parallel-consume",
      chainBinding: { chainId: CHAIN, univocityAddr: DEPLOYED_ADDR },
    });

    const addrBytes = new Uint8Array(20).fill(0xaa);
    const genesisMap = validGenesisV2Es256CborMap({
      chainId: CHAIN,
      univocityAddr: addrBytes,
    });
    await seedGenesisChainIdentity(e, genesisMap);
    const genesisBody = encodeCborDeterministic(genesisMap) as Uint8Array;

    const rootA = crypto.randomUUID();
    const rootB = crypto.randomUUID();

    const genesisReq = (root: string) =>
      worker.fetch(
        new Request(`http://localhost/api/forest/${root}/genesis`, {
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

    const [a, b] = await Promise.all([genesisReq(rootA), genesisReq(rootB)]);
    const statuses = [a.status, b.status].sort();
    // Loser fails at the instance-completion CAS (409) before its token
    // would have been consumed (ADR-0059 decision 8).
    expect(statuses).toEqual([201, 409]);
  });

  it("rejects genesis when token chain binding mismatches genesis body", async () => {
    const e = envWithOnboard();
    const minted = await mintOnboardToken(e, {
      label: "bind-mismatch",
      chainBinding: { chainId: CHAIN, univocityAddr: DEPLOYED_ADDR },
    });
    const root = crypto.randomUUID();
    const wrongAddr = new Uint8Array(20).fill(0xbb);
    // Seed the gate for the wrong-addr body too: the chain-anchored key check
    // passes so the failure under test stays the TOKEN binding mismatch.
    const wrongMap = validGenesisV2Es256CborMap({
      chainId: CHAIN,
      univocityAddr: wrongAddr,
    });
    await seedGenesisChainIdentity(e, wrongMap);
    const res = await worker.fetch(
      new Request(`http://localhost/api/forest/${root}/genesis`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${minted.token}`,
          "Content-Type": "application/cbor",
        },
        body: encodeCborDeterministic(wrongMap) as Uint8Array,
      }),
      e,
      testCtx,
    );
    expect(res.status).toBe(422);
  });

  it("legacy ops-mint token without binding still works", async () => {
    const e = envWithOnboard();
    // Mint now requires a binding; lane-A legacy tokens predate that rule,
    // so seed the at-rest record shape directly.
    const legacyToken = "legacy-".concat(crypto.randomUUID());
    const legacyHash = await hashOnboardToken(legacyToken);
    await e.R2_GRANTS.put(
      onboardTokenR2Key(legacyHash),
      JSON.stringify({
        hash: legacyHash,
        label: "legacy",
        createdAt: Math.floor(Date.now() / 1000),
        status: "active",
      }),
      { httpMetadata: { contentType: "application/json" } },
    );
    const minted = { token: legacyToken, record: { hash: legacyHash } };
    const root = crypto.randomUUID();
    const legacyMap = validGenesisV2Es256CborMap();
    await seedGenesisChainIdentity(e, legacyMap);
    const res = await worker.fetch(
      new Request(`http://localhost/api/forest/${root}/genesis`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${minted.token}`,
          "Content-Type": "application/cbor",
        },
        body: encodeCborDeterministic(legacyMap) as Uint8Array,
      }),
      e,
      testCtx,
    );
    expect(res.status).toBe(201);
  });
});
