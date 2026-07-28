/**
 * `GET /api/payments/chain-bindings` — ops enumeration with receivables
 * join (FOR-478).
 */

import { decodeCborAsObject } from "./helpers/cbor-decode-object.js";
import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import type { Env } from "../src/index";
import {
  completeUnivocityInstanceReservation,
  reserveUnivocityInstance,
} from "../src/payments/instance-registry.js";
import { tryUnivocityInstanceIdFromChainBinding } from "@canopy/univocity-instance-id";

const poolEnv = env as unknown as Env;
const OPS = "vitest-ops-admin-token";
const SETTLEMENT_URL = "https://x402-settlement.test";

const RECEIVABLES_BODY = {
  entitlement: {
    creditsBalance: 7,
    checkpointsAccrued: 3,
    arrears: "current",
    enforcementFrozen: false,
    registrationBlock: 28_100_000,
  },
  watermarkBlock: 28_100_042,
};

function instanceId(addrByte: string): string {
  const id = tryUnivocityInstanceIdFromChainBinding({
    chainId: "84532",
    univocityAddr: addrByte.repeat(20),
  });
  if (!id) throw new Error("bad test binding");
  return id;
}

function listEnv(overrides: Partial<Env> = {}): Env {
  return {
    ...poolEnv,
    CANOPY_OPS_ADMIN_TOKEN: OPS,
    X402_SETTLEMENT_URL: SETTLEMENT_URL,
    ...overrides,
  };
}

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

/** Stub settlement: per-id bodies, 404 for ids not named. */
function stubSettlement(byId: Record<string, unknown>): void {
  globalThis.fetch = vi.fn(async (input) => {
    const url = String(input instanceof Request ? input.url : input);
    if (!url.startsWith(SETTLEMENT_URL)) {
      throw new Error(`unexpected upstream fetch: ${url}`);
    }
    const id = decodeURIComponent(url.slice(url.lastIndexOf("/") + 1));
    const body = byId[id];
    if (body === undefined) {
      return new Response(JSON.stringify({ error: "no account state" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
}

async function getList(e: Env, query = ""): Promise<Response> {
  return worker.fetch(
    new Request(`http://localhost/api/payments/chain-bindings${query}`, {
      method: "GET",
      headers: { Authorization: `Bearer ${OPS}` },
    }),
    e,
    {} as ExecutionContext,
  );
}

interface ListBody {
  instances?: Array<{
    univocityInstanceId?: string;
    state?: string;
    holder?: string;
    reservedAt?: number;
    r?: string;
    registrationBlock?: number | null;
    receivables?: Record<string, unknown> | null;
    receivablesDetail?: string;
  }>;
  cursor?: string;
}

async function decodeList(res: Response): Promise<ListBody> {
  return decodeCborAsObject(
    new Uint8Array(await res.arrayBuffer()),
  ) as ListBody;
}

describe("GET /api/payments/chain-bindings", () => {
  it("requires the ops bearer", async () => {
    const res = await worker.fetch(
      new Request("http://localhost/api/payments/chain-bindings"),
      listEnv(),
      {} as ExecutionContext,
    );
    expect(res.status).toBe(401);
  });

  it("returns an empty listing without a cursor", async () => {
    stubSettlement({});
    const res = await getList(listEnv());
    expect(res.status).toBe(200);
    const body = await decodeList(res);
    expect(body.instances).toEqual([]);
    expect(body.cursor).toBeUndefined();
  });

  it("lists reserved and registered rows, joining receivables only for registered", async () => {
    const reservedId = instanceId("aa");
    const registeredId = instanceId("bb");
    const staleId = instanceId("cc");

    await reserveUnivocityInstance(poolEnv, reservedId, "token:deadbeef");
    await reserveUnivocityInstance(poolEnv, registeredId, "request:r-1");
    await completeUnivocityInstanceReservation(
      poolEnv,
      registeredId,
      ["request:r-1"],
      "11111111-2222-4333-8444-555555555555",
      28_100_000,
    );
    await reserveUnivocityInstance(poolEnv, staleId, "request:r-2");
    await completeUnivocityInstanceReservation(
      poolEnv,
      staleId,
      ["request:r-2"],
      "66666666-7777-4888-9999-aaaaaaaaaaaa",
      null,
    );

    // staleId is deliberately absent: registered in the registry but the
    // indexer has no account state yet — the row degrades, the listing holds.
    stubSettlement({ [registeredId]: RECEIVABLES_BODY });

    const res = await getList(listEnv());
    expect(res.status).toBe(200);
    const body = await decodeList(res);
    expect(body.instances).toHaveLength(3);
    const byId = new Map(
      body.instances!.map((row) => [row.univocityInstanceId, row]),
    );

    const reserved = byId.get(reservedId)!;
    expect(reserved.state).toBe("reserved");
    expect(reserved.holder).toBe("token:deadbeef");
    expect("receivables" in reserved).toBe(false);

    const registered = byId.get(registeredId)!;
    expect(registered.state).toBe("registered");
    expect(registered.r).toBe("11111111-2222-4333-8444-555555555555");
    expect(registered.registrationBlock).toBe(28_100_000);
    expect(registered.receivables).toMatchObject({
      creditsBalance: 7,
      checkpointsAccrued: 3,
      arrears: "current",
      enforcementFrozen: false,
      watermarkBlock: 28_100_042,
    });

    const stale = byId.get(staleId)!;
    expect(stale.state).toBe("registered");
    expect(stale.receivables).toBeNull();
    expect(stale.receivablesDetail).toBe("no account state for instance");
  });

  it("degrades registered rows when the settlement read is not configured", async () => {
    const id = instanceId("dd");
    await reserveUnivocityInstance(poolEnv, id, "request:r-3");
    await completeUnivocityInstanceReservation(
      poolEnv,
      id,
      ["request:r-3"],
      "11111111-2222-4333-8444-555555555555",
      null,
    );

    const res = await getList(listEnv({ X402_SETTLEMENT_URL: undefined }));
    expect(res.status).toBe(200);
    const body = await decodeList(res);
    expect(body.instances).toHaveLength(1);
    expect(body.instances![0]!.receivables).toBeNull();
    expect(body.instances![0]!.receivablesDetail).toContain("not configured");
  });

  it("pages with limit and cursor", async () => {
    stubSettlement({});
    for (const byte of ["aa", "bb", "cc"]) {
      await reserveUnivocityInstance(
        poolEnv,
        instanceId(byte),
        `token:${byte}`,
      );
    }

    const first = await getList(listEnv(), "?limit=2");
    expect(first.status).toBe(200);
    const firstBody = await decodeList(first);
    expect(firstBody.instances).toHaveLength(2);
    expect(typeof firstBody.cursor).toBe("string");

    const second = await getList(
      listEnv(),
      `?limit=2&cursor=${encodeURIComponent(firstBody.cursor!)}`,
    );
    expect(second.status).toBe(200);
    const secondBody = await decodeList(second);
    expect(secondBody.instances).toHaveLength(1);
    expect(secondBody.cursor).toBeUndefined();

    const ids = [...firstBody.instances!, ...secondBody.instances!].map(
      (row) => row.univocityInstanceId,
    );
    expect(new Set(ids).size).toBe(3);
  });

  it("rejects malformed limits", async () => {
    for (const bad of ["0", "101", "abc", "-1", "2.5"]) {
      const res = await getList(listEnv(), `?limit=${bad}`);
      expect(res.status).toBe(400);
    }
  });

  it("405s non-GET methods", async () => {
    const res = await worker.fetch(
      new Request("http://localhost/api/payments/chain-bindings", {
        method: "POST",
        headers: { Authorization: `Bearer ${OPS}` },
      }),
      listEnv(),
      {} as ExecutionContext,
    );
    expect(res.status).toBe(405);
  });
});
