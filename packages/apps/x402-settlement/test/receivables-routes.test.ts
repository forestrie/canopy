/**
 * Admin routes that drive ReceivablesDO methods which throw (watermark-set
 * forward-only guard, unbound-account guard). Runs in the receivables
 * project (isolated storage OFF — see vitest.receivables.config.ts); each
 * test self-isolates via a unique instance id.
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

function wmRequest(id: string, body: unknown, token?: string): Request {
  return new Request(
    `http://localhost/admin/receivables/${encodeURIComponent(id)}/watermark`,
    {
      method: "PUT",
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      body: JSON.stringify(body),
    },
  );
}

async function callFetch(req: Request, e: Env): Promise<Response> {
  return worker.fetch(req, e, createExecutionContext());
}

describe("PUT /admin/receivables/{id}/watermark (slice 04 ops tool)", () => {
  // The route validates the id as canonical CAIP-10 BEFORE touching the DO,
  // so route tests use a canonical id and self-isolation comes from per-test
  // uniqueness in the *watermark key*, not the DO name.
  const ID = `eip155:84532:0x${"ef".repeat(20)}`;
  const ACCOUNT = {
    univocityInstanceId: ID,
    chainId: "84532",
    univocityAddr: "ef".repeat(20),
    root: "55555555-5555-4555-8555-555555555555",
  };

  function stub() {
    return typedEnv.RECEIVABLES_DO.get(typedEnv.RECEIVABLES_DO.idFromName(ID));
  }

  it("401s without the bearer", async () => {
    const req = wmRequest(ID, {
      chainId: "84532",
      univocityAddr: ACCOUNT.univocityAddr,
      lastBlock: 10,
    });
    expect((await callFetch(req, opsEnv())).status).toBe(401);
  });

  it("404s while no account is bound, then moves forward, then 409s a rewind", async () => {
    const e = opsEnv();
    const unbound = await callFetch(
      wmRequest(
        ID,
        {
          chainId: "84532",
          univocityAddr: ACCOUNT.univocityAddr,
          lastBlock: 10,
        },
        OPS,
      ),
      e,
    );
    expect(unbound.status).toBe(404);

    await stub().applyCheckpointEvents(ACCOUNT, [], 1000);

    const ok = await callFetch(
      wmRequest(
        ID,
        {
          chainId: "84532",
          univocityAddr: ACCOUNT.univocityAddr,
          lastBlock: 5000,
        },
        OPS,
      ),
      e,
    );
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { lastBlock: number }).lastBlock).toBe(5000);
    expect((await stub().getIndexState(ID)).lastBlock).toBe(5000);

    const rewind = await callFetch(
      wmRequest(
        ID,
        {
          chainId: "84532",
          univocityAddr: ACCOUNT.univocityAddr,
          lastBlock: 100,
        },
        OPS,
      ),
      e,
    );
    expect(rewind.status).toBe(409);
  });

  it("400s a malformed body and a non-canonical id", async () => {
    const e = opsEnv();
    expect(
      (await callFetch(wmRequest(ID, { lastBlock: "ten" }, OPS), e)).status,
    ).toBe(400);
    expect(
      (
        await callFetch(
          wmRequest(
            "not-an-id",
            { chainId: "1", univocityAddr: "a", lastBlock: 1 },
            OPS,
          ),
          e,
        )
      ).status,
    ).toBe(400);
  });
});
