/**
 * /admin/** ops gate (plan-2607-43 slice 03): reset-auth is no longer
 * unauthenticated, and the receivables status read shares the same bearer.
 */
import { env, createExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "../src/index.js";
import type { Env } from "../src/env.js";

const typedEnv = env as Env;
const OPS = "vitest-x402-ops-token";

function opsEnv(): Env {
  return { ...typedEnv, CANOPY_OPS_ADMIN_TOKEN: OPS } as Env;
}

const ADDR = "cd".repeat(20);
const INSTANCE_ID = `eip155:84532:0x${ADDR}`;

async function callFetch(req: Request, e: Env): Promise<Response> {
  return worker.fetch(req, e, createExecutionContext());
}

describe("/admin/reset-auth gate", () => {
  it("401s without the ops bearer (fail closed, even when unset)", async () => {
    const req = new Request("http://localhost/admin/reset-auth", {
      method: "POST",
      body: JSON.stringify({ authId: "local:0xabc" }),
    });
    expect((await callFetch(req, typedEnv)).status).toBe(401);
    expect((await callFetch(req.clone(), opsEnv())).status).toBe(401);
  });

  it("200s with the ops bearer", async () => {
    const req = new Request("http://localhost/admin/reset-auth", {
      method: "POST",
      headers: { Authorization: `Bearer ${OPS}` },
      body: JSON.stringify({ authId: "local:0xabc" }),
    });
    expect((await callFetch(req, opsEnv())).status).toBe(200);
  });
});

describe("/admin/sweep", () => {
  it("401s without the ops bearer", async () => {
    const req = new Request("http://localhost/admin/sweep", {
      method: "POST",
    });
    expect((await callFetch(req, opsEnv())).status).toBe(401);
  });

  it("runs a sweep and returns the run summary shape", async () => {
    // SUPPORTED_CHAINS_RPC unset in the pool env: the sweep is skipped
    // internally but still returns the summary — the canary asserts on the
    // receivables read, not this response, so shape is the contract here.
    const req = new Request("http://localhost/admin/sweep", {
      method: "POST",
      headers: { Authorization: `Bearer ${OPS}` },
    });
    const res = await callFetch(req, opsEnv());
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(typeof body.accounts).toBe("number");
    expect(typeof body.scanned).toBe("number");
    expect(typeof body.applied).toBe("number");
    expect(typeof body.errors).toBe("number");
  });
});

describe("/admin/receivables/{id}", () => {
  it("401s without the bearer and 400s a non-canonical id", async () => {
    const e = opsEnv();
    const anon = new Request(
      `http://localhost/admin/receivables/${encodeURIComponent(INSTANCE_ID)}`,
    );
    expect((await callFetch(anon, e)).status).toBe(401);
    const bad = new Request("http://localhost/admin/receivables/84532:abcd", {
      headers: { Authorization: `Bearer ${OPS}` },
    });
    expect((await callFetch(bad, e)).status).toBe(400);
  });

  it("404s an untouched account, then returns state after accrual", async () => {
    const e = opsEnv();
    const url = `http://localhost/admin/receivables/${encodeURIComponent(INSTANCE_ID)}`;
    const authed = () =>
      new Request(url, { headers: { Authorization: `Bearer ${OPS}` } });
    expect((await callFetch(authed(), e)).status).toBe(404);

    const stub = typedEnv.RECEIVABLES_DO.get(
      typedEnv.RECEIVABLES_DO.idFromName(INSTANCE_ID),
    );
    await stub.applyCheckpointEvents(
      {
        univocityInstanceId: INSTANCE_ID,
        chainId: "84532",
        univocityAddr: ADDR,
        root: "33333333-3333-4333-8333-333333333333",
      },
      [{ idempotencyKey: "0xt9:0", logKind: 1, size: 2 }],
      42,
    );
    const res = await callFetch(authed(), e);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      watermarkBlock?: number;
      entitlement?: { checkpointsAccrued?: number; arrears?: string };
    };
    expect(body.watermarkBlock).toBe(42);
    expect(body.entitlement?.checkpointsAccrued).toBe(1);
    expect(body.entitlement?.arrears).toBe("in-arrears");
  });
});
