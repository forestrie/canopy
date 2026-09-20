/**
 * POST /admin/reset-storage gate and behaviour — mirrors
 * delegation-coordinator's test/unit/admin-reset-storage.test.ts, adapted for
 * this worker's two independently-keyed DO classes (see
 * src/durableobjects/receivables.ts): `shard=<index>|all` for
 * {@link X402SettlementDO} shards, `instance=<univocityInstanceId>` for one
 * {@link ReceivablesDO}.
 */
import { env, createExecutionContext } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SettlementJob } from "@canopy/x402-settlement-types";
import worker from "../src/index.js";
import type { Env } from "../src/env.js";

const typedEnv = env as Env;
const TOKEN = "test-settlement-reset-token-0123456789";

/** Sentinel meaning "send the request with no reset header at all". */
const NO_HEADER = Symbol("no-header");

function resetEnv(overrides: Partial<Env> = {}): Env {
  return {
    ...typedEnv,
    NODE_ENV: "dev",
    SETTLEMENT_RESET_TOKEN: TOKEN,
    ...overrides,
  } as Env;
}

function resetRequest(
  query: string,
  token: string | typeof NO_HEADER = TOKEN,
): Request {
  const url = new URL(`http://localhost/admin/reset-storage${query}`);
  const headers = new Headers();
  if (token !== NO_HEADER) {
    headers.set("X-Forestrie-Settlement-Reset", token);
  }
  return new Request(url, { method: "POST", headers });
}

async function callFetch(req: Request, e: Env): Promise<Response> {
  return worker.fetch(req, e, createExecutionContext());
}

const INSTANCE_ID = "eip155:84532:0xabababababababababababababababababababab";

describe("handleAdminResetStorage environment gating", () => {
  it("hides the endpoint on non-dev workers by default", async () => {
    const res = await callFetch(
      resetRequest("?shard=all"),
      resetEnv({ NODE_ENV: "prod" }),
    );
    expect(res.status).toBe(404);
  });

  it("allows non-dev workers that opt in with SETTLEMENT_RESET_ALLOWED", async () => {
    const res = await callFetch(
      resetRequest("?shard=all", "wrong-token"),
      resetEnv({ NODE_ENV: "prod", SETTLEMENT_RESET_ALLOWED: "1" }),
    );
    expect(res.status).toBe(401);
  });

  it("503s when the reset token is not configured, even opted in", async () => {
    const res = await callFetch(
      resetRequest("?shard=all"),
      resetEnv({
        NODE_ENV: "prod",
        SETTLEMENT_RESET_ALLOWED: "1",
        SETTLEMENT_RESET_TOKEN: undefined,
      }),
    );
    expect(res.status).toBe(503);
  });

  it("503s when the configured token is shorter than 16 chars", async () => {
    const res = await callFetch(
      resetRequest("?shard=all"),
      resetEnv({ SETTLEMENT_RESET_TOKEN: "short" }),
    );
    expect(res.status).toBe(503);
  });

  it("401s a bad token on dev workers", async () => {
    const res = await callFetch(
      resetRequest("?shard=all", "wrong-token"),
      resetEnv(),
    );
    expect(res.status).toBe(401);
  });

  it("401s a missing token header", async () => {
    const res = await callFetch(
      resetRequest("?shard=all", NO_HEADER),
      resetEnv(),
    );
    expect(res.status).toBe(401);
  });

  it("400s when neither shard nor instance is given", async () => {
    const res = await callFetch(resetRequest(""), resetEnv());
    expect(res.status).toBe(400);
  });
});

/** A minimal settlement job so processJob reaches the facilitator call. */
function failingJob(authId: string, idempotencyKey: string): SettlementJob {
  return {
    jobId: `job-${idempotencyKey}`,
    kind: "credits",
    authId,
    scheme: "exact",
    payer: "0x0c552c20eee6644112b4965ff70f929c4ab80d4b",
    amount: "1000",
    idempotencyKey,
    createdAt: 1_700_000_000_000,
    payload: {
      x402Version: 2,
      payload: {
        signature: "0xsig",
        authorization: {
          from: "0x0c552c20eee6644112b4965ff70f929c4ab80d4b",
          to: "0x75be7950F26fe7F15336a10b33A8D8134faDb787",
          value: "1000",
          validAfter: "0",
          validBefore: "9999999999",
          nonce: "0xn",
        },
      },
      resource: { url: "https://x/credits", mimeType: "application/json" },
      accepted: {
        scheme: "exact",
        network: "eip155:84532",
        amount: "1000",
        asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
        payTo: "0x75be7950F26fe7F15336a10b33A8D8134faDb787",
      },
    },
  };
}

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

/** Network failure on settle records an auth_state row (recordFailure). */
function stubSettleNetworkError(): void {
  globalThis.fetch = vi.fn(async () => {
    throw new Error("network unreachable");
  }) as typeof fetch;
}

describe("handleAdminResetStorage — shard target (X402SettlementDO)", () => {
  it("wipes a single shard's auth_state and settled_jobs", async () => {
    const e = resetEnv();
    const authId = "local:0xreset-shard-target";
    const shardCount = parseInt(typedEnv.DO_SHARD_COUNT, 10) || 4;
    // Same djb2-mod routing as resolveShardId in src/index.ts.
    const { hashLogId } = await import("@canopy/forestrie-sharding");
    const shardIndex = hashLogId(authId) % shardCount;
    const stub = typedEnv.X402_SETTLEMENT_DO.get(
      typedEnv.X402_SETTLEMENT_DO.idFromName(`shard-${shardIndex}`),
    );

    stubSettleNetworkError();
    await stub.processJob(failingJob(authId, "credits:reset-shard:0xn1"));
    expect(await stub.getAuthInfo(authId)).not.toBeNull();

    const res = await callFetch(resetRequest(`?shard=${shardIndex}`), e);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; reset: number };
    expect(body.ok).toBe(true);
    expect(body.reset).toBe(shardIndex);

    expect(await stub.getAuthInfo(authId)).toBeNull();
  });

  it("wipes every shard on shard=all", async () => {
    const e = resetEnv();
    const shardCount = parseInt(typedEnv.DO_SHARD_COUNT, 10) || 4;
    const stubs = Array.from({ length: shardCount }, (_, i) =>
      typedEnv.X402_SETTLEMENT_DO.get(
        typedEnv.X402_SETTLEMENT_DO.idFromName(`shard-${i}`),
      ),
    );

    stubSettleNetworkError();
    for (const [i, stub] of stubs.entries()) {
      await stub.processJob(
        failingJob(`local:0xall-${i}`, `credits:reset-all-${i}:0xn1`),
      );
    }
    for (const [i, stub] of stubs.entries()) {
      expect(await stub.getAuthInfo(`local:0xall-${i}`)).not.toBeNull();
    }

    const res = await callFetch(resetRequest("?shard=all"), e);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      reset: string;
      shardCount: number;
    };
    expect(body.ok).toBe(true);
    expect(body.reset).toBe("all");
    expect(body.shardCount).toBe(shardCount);

    for (const [i, stub] of stubs.entries()) {
      expect(await stub.getAuthInfo(`local:0xall-${i}`)).toBeNull();
    }
  });

  it("400s an out-of-range shard index", async () => {
    const e = resetEnv();
    const shardCount = parseInt(typedEnv.DO_SHARD_COUNT, 10) || 4;
    const res = await callFetch(resetRequest(`?shard=${shardCount + 5}`), e);
    expect(res.status).toBe(400);
  });
});

describe("handleAdminResetStorage — instance target (ReceivablesDO)", () => {
  it("wipes one ReceivablesDO account", async () => {
    const e = resetEnv();
    const stub = typedEnv.RECEIVABLES_DO.get(
      typedEnv.RECEIVABLES_DO.idFromName(INSTANCE_ID),
    );
    await stub.applyCheckpointEvents(
      {
        univocityInstanceId: INSTANCE_ID,
        chainId: "84532",
        univocityAddr: "ababababababababababababababababababab",
        root: "22222222-2222-4222-8222-222222222222",
      },
      [{ idempotencyKey: "0xreset-instance:0", logKind: 1, size: 2 }],
      7,
    );
    expect(await stub.getEntitlement(INSTANCE_ID)).not.toBeNull();

    const res = await callFetch(
      resetRequest(`?instance=${encodeURIComponent(INSTANCE_ID)}`),
      e,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      reset: string;
      instance: string;
    };
    expect(body.ok).toBe(true);
    expect(body.reset).toBe("instance");
    expect(body.instance).toBe(INSTANCE_ID);

    expect(await stub.getEntitlement(INSTANCE_ID)).toBeNull();
  });

  it("400s a non-canonical instance id", async () => {
    const e = resetEnv();
    const res = await callFetch(
      resetRequest("?instance=not-a-canonical-id"),
      e,
    );
    expect(res.status).toBe(400);
  });
});

/** Register an instance in the reservation registry the way canopy-api's
 * instance-registry does (see indexer/instance-accounts.ts), so
 * listRegisteredAccounts / instance=all finds it. */
async function registerInstance(
  id: string,
  addr: string,
  root: string,
): Promise<void> {
  await typedEnv.R2_GRANTS!.put(
    `forests/index/chain-binding/${id}`,
    JSON.stringify({
      state: "registered",
      holder: "genesis",
      reservedAt: 1719000000,
      r: root,
    }),
  );
}

/** A "reserved" (not yet "registered") record — listRegisteredAccounts skips
 * these (see instance-accounts.ts), the enumeration gap the handler's doc
 * comment names. */
async function reserveOnlyInstance(id: string): Promise<void> {
  await typedEnv.R2_GRANTS!.put(
    `forests/index/chain-binding/${id}`,
    JSON.stringify({ state: "reserved", holder: "genesis", reservedAt: 1 }),
  );
}

describe("handleAdminResetStorage — instance=all (every registered ReceivablesDO)", () => {
  it("resets every registered instance and returns their count and ids", async () => {
    const e = resetEnv();
    const ids = [
      `eip155:84532:0x${"a1".repeat(20)}`,
      `eip155:84532:0x${"a2".repeat(20)}`,
      `eip155:84532:0x${"a3".repeat(20)}`,
    ];
    const stubs = ids.map((id) =>
      typedEnv.RECEIVABLES_DO.get(typedEnv.RECEIVABLES_DO.idFromName(id)),
    );
    for (const [i, id] of ids.entries()) {
      await registerInstance(
        id,
        id.slice("eip155:84532:0x".length),
        `33333333-3333-4333-8333-33333333333${i}`,
      );
      await stubs[i]!.applyCheckpointEvents(
        {
          univocityInstanceId: id,
          chainId: "84532",
          univocityAddr: id.slice("eip155:84532:0x".length),
          root: `33333333-3333-4333-8333-33333333333${i}`,
        },
        [{ idempotencyKey: `0xreset-all-instances:${i}`, logKind: 1, size: 2 }],
        7,
      );
      expect(await stubs[i]!.getEntitlement(id)).not.toBeNull();
    }
    // Also register one instance whose state is "reserved", not
    // "registered" — must not appear in the reset count or id list
    // (listRegisteredAccounts skips it; the handler doc names this gap).
    const reservedOnly = `eip155:84532:0x${"a4".repeat(20)}`;
    await reserveOnlyInstance(reservedOnly);

    const res = await callFetch(resetRequest("?instance=all"), e);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      reset: string;
      count: number;
      instances: string[];
    };
    expect(body.ok).toBe(true);
    expect(body.reset).toBe("all-instances");
    expect(body.count).toBe(ids.length);
    expect(new Set(body.instances)).toEqual(new Set(ids));
    expect(body.instances).not.toContain(reservedOnly);

    for (const [i, id] of ids.entries()) {
      expect(await stubs[i]!.getEntitlement(id)).toBeNull();
    }
  });

  it("200s with count 0 when nothing is registered", async () => {
    const e = resetEnv();
    const res = await callFetch(resetRequest("?instance=all"), e);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      reset: string;
      count: number;
      instances: string[];
    };
    expect(body.ok).toBe(true);
    expect(body.reset).toBe("all-instances");
    expect(body.count).toBe(0);
    expect(body.instances).toEqual([]);
  });

  it("503s when R2_GRANTS is unbound", async () => {
    const e = resetEnv({ R2_GRANTS: undefined });
    const res = await callFetch(resetRequest("?instance=all"), e);
    expect(res.status).toBe(503);
  });
});

describe("handleAdminResetStorage — shard=all&instance=all (single-call content-reset)", () => {
  it("resets every settlement shard and every registered ReceivablesDO in one request", async () => {
    const e = resetEnv();
    const shardCount = parseInt(typedEnv.DO_SHARD_COUNT, 10) || 4;
    const shardStubs = Array.from({ length: shardCount }, (_, i) =>
      typedEnv.X402_SETTLEMENT_DO.get(
        typedEnv.X402_SETTLEMENT_DO.idFromName(`shard-${i}`),
      ),
    );
    stubSettleNetworkError();
    for (const [i, stub] of shardStubs.entries()) {
      await stub.processJob(
        failingJob(`local:0xcombined-${i}`, `credits:combined-${i}:0xn1`),
      );
    }

    const instanceId = `eip155:84532:0x${"b1".repeat(20)}`;
    const receivablesStub = typedEnv.RECEIVABLES_DO.get(
      typedEnv.RECEIVABLES_DO.idFromName(instanceId),
    );
    await registerInstance(
      instanceId,
      instanceId.slice("eip155:84532:0x".length),
      "44444444-4444-4444-8444-444444444444",
    );
    await receivablesStub.applyCheckpointEvents(
      {
        univocityInstanceId: instanceId,
        chainId: "84532",
        univocityAddr: instanceId.slice("eip155:84532:0x".length),
        root: "44444444-4444-4444-8444-444444444444",
      },
      [{ idempotencyKey: "0xcombined-instance:0", logKind: 1, size: 2 }],
      7,
    );

    const res = await callFetch(resetRequest("?shard=all&instance=all"), e);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      shard: { reset: string; shardCount: number };
      instance: { reset: string; count: number; instances: string[] };
    };
    expect(body.ok).toBe(true);
    expect(body.shard.reset).toBe("all");
    expect(body.shard.shardCount).toBe(shardCount);
    expect(body.instance.reset).toBe("all-instances");
    expect(body.instance.count).toBe(1);
    expect(body.instance.instances).toEqual([instanceId]);

    for (const [i, stub] of shardStubs.entries()) {
      expect(await stub.getAuthInfo(`local:0xcombined-${i}`)).toBeNull();
    }
    expect(await receivablesStub.getEntitlement(instanceId)).toBeNull();
  });
});
