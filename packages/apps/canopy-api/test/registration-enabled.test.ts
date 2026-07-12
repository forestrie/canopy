/**
 * Registration kill-switch ops API (FOR-91).
 */

import { encodeCborDeterministic } from "@forestrie/encoding";
import { decodeCborAsObject } from "./helpers/cbor-decode-object.js";
import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import type { Env } from "../src/index";
import { mintOnboardToken } from "../src/payments/onboard-token-store.js";
import { validGenesisV2Es256CborMap } from "./helpers/genesis-v2-body.js";
import { expectAdminJsonProblem } from "./helpers/admin-json.js";

const poolEnv = env as unknown as Env;
const OPS = "vitest-ops-admin-token";
const COORD_URL = "https://coordinator.test";
const COORD_TOKEN = "vitest-coordinator-token";

function envWithPayments(): Env {
  return {
    ...poolEnv,
    CANOPY_OPS_ADMIN_TOKEN: OPS,
    DELEGATION_COORDINATOR_URL: COORD_URL,
    COORDINATOR_APP_TOKEN: COORD_TOKEN,
  };
}

function envWithoutCoordinator(): Env {
  return {
    ...poolEnv,
    CANOPY_OPS_ADMIN_TOKEN: OPS,
    DELEGATION_COORDINATOR_URL: undefined,
    COORDINATOR_APP_TOKEN: undefined,
  };
}

function opsHeaders(extra?: Record<string, string>): Record<string, string> {
  return {
    Authorization: `Bearer ${OPS}`,
    "Content-Type": "application/cbor",
    ...extra,
  };
}

async function registerPaymentAuthoritativeForest(): Promise<string> {
  const minted = await mintOnboardToken(poolEnv);
  const logId = crypto.randomUUID();
  const res = await worker.fetch(
    new Request(`http://localhost/api/forest/${logId}/genesis`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${minted.token}`,
        "Content-Type": "application/cbor",
      },
      body: encodeCborDeterministic(validGenesisV2Es256CborMap()) as Uint8Array,
    }),
    poolEnv,
    {} as ExecutionContext,
  );
  expect(res.status).toBe(201);
  return logId;
}

describe("registration enabled kill-switch API", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("rejects without ops bearer", async () => {
    const logId = crypto.randomUUID();
    const res = await worker.fetch(
      new Request(
        `http://localhost/api/payments/registrations/${logId}/enabled`,
        { method: "GET" },
      ),
      envWithPayments(),
      {} as ExecutionContext,
    );
    expect(res.status).toBe(401);
  });

  it("returns 400 for invalid R", async () => {
    const res = await worker.fetch(
      new Request(
        "http://localhost/api/payments/registrations/not-a-uuid/enabled",
        { method: "GET", headers: { Authorization: `Bearer ${OPS}` } },
      ),
      envWithPayments(),
      {} as ExecutionContext,
    );
    expect(res.status).toBe(400);
  });

  it("returns 404 when registration record is missing", async () => {
    const logId = crypto.randomUUID();
    const res = await worker.fetch(
      new Request(
        `http://localhost/api/payments/registrations/${logId}/enabled`,
        { method: "GET", headers: { Authorization: `Bearer ${OPS}` } },
      ),
      envWithPayments(),
      {} as ExecutionContext,
    );
    expect(res.status).toBe(404);
  });

  it("returns 503 when coordinator URL is not configured", async () => {
    const logId = await registerPaymentAuthoritativeForest();
    const res = await worker.fetch(
      new Request(
        `http://localhost/api/payments/registrations/${logId}/enabled`,
        { method: "GET", headers: { Authorization: `Bearer ${OPS}` } },
      ),
      envWithoutCoordinator(),
      {} as ExecutionContext,
    );
    expect(res.status).toBe(503);
  });

  it("PUT forwards enabled to coordinator and returns CBOR", async () => {
    const logId = await registerPaymentAuthoritativeForest();
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ enabled: false }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const res = await worker.fetch(
      new Request(
        `http://localhost/api/payments/registrations/${logId}/enabled`,
        {
          method: "PUT",
          headers: opsHeaders(),
          body: encodeCborDeterministic(new Map([[1, false]])) as Uint8Array,
        },
      ),
      envWithPayments(),
      {} as ExecutionContext,
    );
    expect(res.status).toBe(200);
    const body = decodeCborAsObject(new Uint8Array(await res.arrayBuffer())) as {
      R?: string;
      enabled?: boolean;
    };
    expect(body.R).toBe(logId);
    expect(body.enabled).toBe(false);

    expect(fetchMock).toHaveBeenCalledWith(
      `${COORD_URL}/admin/api/logs/${encodeURIComponent(logId)}/enabled`,
      expect.objectContaining({
        method: "PUT",
        headers: expect.objectContaining({
          Authorization: `Bearer ${COORD_TOKEN}`,
        }),
      }),
    );
  });

  it("GET reads enabled from coordinator", async () => {
    const logId = await registerPaymentAuthoritativeForest();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ enabled: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const res = await worker.fetch(
      new Request(
        `http://localhost/api/payments/registrations/${logId}/enabled`,
        { method: "GET", headers: { Authorization: `Bearer ${OPS}` } },
      ),
      envWithPayments(),
      {} as ExecutionContext,
    );
    expect(res.status).toBe(200);
    const body = decodeCborAsObject(new Uint8Array(await res.arrayBuffer())) as {
      R?: string;
      enabled?: boolean;
    };
    expect(body.R).toBe(logId);
    expect(body.enabled).toBe(true);
  });

  it("admin JSON GET returns JSON enabled state", async () => {
    const logId = await registerPaymentAuthoritativeForest();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ enabled: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const res = await worker.fetch(
      new Request(
        `http://localhost/api/payments/admin/registrations/${logId}/enabled`,
        { method: "GET", headers: { Authorization: `Bearer ${OPS}` } },
      ),
      envWithPayments(),
      {} as ExecutionContext,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    const body = (await res.json()) as { R?: string; enabled?: boolean };
    expect(body.R).toBe(logId);
    expect(body.enabled).toBe(true);
  });

  it("admin JSON PUT toggles enabled via coordinator", async () => {
    const logId = await registerPaymentAuthoritativeForest();
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ enabled: false }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const res = await worker.fetch(
      new Request(
        `http://localhost/api/payments/admin/registrations/${logId}/enabled`,
        {
          method: "PUT",
          headers: {
            Authorization: `Bearer ${OPS}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ enabled: false }),
        },
      ),
      envWithPayments(),
      {} as ExecutionContext,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { R?: string; enabled?: boolean };
    expect(body.enabled).toBe(false);
    expect(fetchMock).toHaveBeenCalled();
  });

  it("admin JSON routes reject without bearer", async () => {
    const logId = crypto.randomUUID();
    const res = await worker.fetch(
      new Request(
        `http://localhost/api/payments/admin/registrations/${logId}/enabled`,
        { method: "GET" },
      ),
      envWithPayments(),
      {} as ExecutionContext,
    );
    await expectAdminJsonProblem(res, 401, "CANOPY_OPS_ADMIN_TOKEN");
  });
});
