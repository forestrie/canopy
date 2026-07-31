/**
 * Univocity genesis-forward hardening (plan-2607-10 R7): success is never
 * returned without the local R2 copy — it is authoritative for reads until
 * the log's first checkpoint. `exists` from univocity falls through to the
 * local-copy logic; when the local copy is missing (created-then-put-fail
 * crash window) the stored genesis is read back and byte-diffed before the
 * retry body may become the local copy.
 */

import { encodeCborDeterministic } from "@forestrie/encoding";
import { env, fetchMock } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import worker from "../src/index";
import type { Env } from "../src/index";
import {
  seedGenesisChainIdentity,
  validGenesisV2Ks256CborMap,
} from "./helpers/genesis-v2-body.js";
import { mintTestOnboardToken } from "./helpers/onboard-token.js";

const poolEnv = env as unknown as Env;
const UNIVOCITY_URL = "https://univocity.test";

function envWithUnivocity(): Env {
  return {
    ...poolEnv,
    UNIVOCITY_SERVICE_URL: UNIVOCITY_URL,
    UNIVOCITY_API_TOKEN: "univocity-token-test",
  } as Env;
}

function genesisRequest(
  logId: string,
  bodyMap: Map<number, unknown>,
  auth: string,
): Request {
  return new Request(
    `http://localhost/api/forest/${encodeURIComponent(logId)}/genesis`,
    {
      method: "POST",
      headers: { "Content-Type": "application/cbor", Authorization: auth },
      body: encodeCborDeterministic(bodyMap),
    },
  );
}

function interceptGenesisPost(logId: string, status: number): void {
  fetchMock
    .get(UNIVOCITY_URL)
    .intercept({ path: `/api/forest/${logId}/genesis`, method: "POST" })
    .reply(status, "");
}

function interceptGenesisGet(
  logId: string,
  status: number,
  body: Uint8Array | string = "",
): void {
  fetchMock
    .get(UNIVOCITY_URL)
    .intercept({ path: `/api/forest/${logId}/genesis`, method: "GET" })
    .reply(status, body);
}

async function postGenesis(
  e: Env,
  logId: string,
  bodyMap: Map<number, unknown>,
): Promise<Response> {
  const { token } = await mintTestOnboardToken(e, "univocity-forward-test");
  const res = await worker.fetch(
    genesisRequest(logId, bodyMap, `Bearer ${token}`),
    e,
    {} as ExecutionContext,
  );
  // Always drain the body: an unconsumed stream holds the request context
  // (and its storage connections) open past the test's isolated-storage
  // frame pop.
  const body = await res.arrayBuffer();
  return new Response(body, { status: res.status, headers: res.headers });
}

function localGenesisKey(logId: string): string {
  return `forests/forest/${logId}/genesis.cbor`;
}

describe("univocity genesis forward (plan-2607-10 R7)", () => {
  beforeEach(() => {
    fetchMock.activate();
    fetchMock.disableNetConnect();
    // Best-effort registration-block RPC observation is not under test:
    // give it a soft failure so the claim path proceeds with a null floor.
    fetchMock
      .get("https://sepolia.base.org")
      .intercept({ path: "/", method: "POST" })
      .reply(500, "rpc unavailable in test")
      .persist();
  });

  afterEach(() => {
    // No assertNoPendingInterceptors here: it THROWS on the persisted
    // sepolia interceptor above, and an afterEach exception corrupts the
    // pool's isolated-storage frame pop ("Failed to pop R2 storage").
    // Unexpected univocity calls are still caught — disableNetConnect
    // refuses anything unintercepted, which surfaces in the tested status.
    fetchMock.deactivate();
  });

  it("created: writes the local authoritative copy before success", async () => {
    const e = envWithUnivocity();
    const logId = crypto.randomUUID();
    const m = validGenesisV2Ks256CborMap();
    await seedGenesisChainIdentity(e, m);
    interceptGenesisPost(logId, 201);

    const res = await postGenesis(e, logId, m);
    expect(res.status).toBe(201);
    // head, not get: an unread R2ObjectBody stream holds the isolated-storage
    // frame open past the test.
    const local = await e.R2_GRANTS.head(localGenesisKey(logId));
    expect(local).not.toBeNull();
  });

  it("exists with no local copy: reads back, diffs equal, self-heals the local copy", async () => {
    const e = envWithUnivocity();
    const logId = crypto.randomUUID();
    const m = validGenesisV2Ks256CborMap();
    await seedGenesisChainIdentity(e, m);
    // Materialise the CANONICAL genesis bytes via a created run (the handler
    // forwards its own canonical encoding, not the request body verbatim),
    // then delete the local copy — the created-then-local-put-fail crash
    // window the R7 hardening exists for.
    interceptGenesisPost(logId, 201);
    expect((await postGenesis(e, logId, m)).status).toBe(201);
    const canonical = new Uint8Array(
      await (await e.R2_GRANTS.get(localGenesisKey(logId)))!.arrayBuffer(),
    );
    await e.R2_GRANTS.delete(localGenesisKey(logId));

    interceptGenesisPost(logId, 409);
    interceptGenesisGet(logId, 200, canonical);
    const res = await postGenesis(e, logId, m);
    // Idempotent success — AND the local copy exists again (the old code
    // returned success here with the copy permanently missing).
    expect(res.status).toBe(201);
    const local = await e.R2_GRANTS.get(localGenesisKey(logId));
    expect(local).not.toBeNull();
    expect(new Uint8Array(await local!.arrayBuffer())).toEqual(canonical);
  });

  it("exists with no local copy: a DIVERGENT retry body is refused 409, never adopted", async () => {
    const e = envWithUnivocity();
    const logId = crypto.randomUUID();
    const m = validGenesisV2Ks256CborMap();
    await seedGenesisChainIdentity(e, m);
    // Univocity holds a genesis with a DIFFERENT bootstrap key.
    const divergent = validGenesisV2Ks256CborMap({
      bootstrapKey: new Uint8Array(20).fill(0xcc),
    });
    interceptGenesisPost(logId, 409);
    interceptGenesisGet(logId, 200, encodeCborDeterministic(divergent));

    const res = await postGenesis(e, logId, m);
    expect(res.status).toBe(409);
    // The divergent retry must NOT have become the local authoritative copy.
    expect(await e.R2_GRANTS.get(localGenesisKey(logId))).toBeNull();
  });

  it("exists but read-back unavailable: fails closed 503 (retryable), no local write", async () => {
    const e = envWithUnivocity();
    const logId = crypto.randomUUID();
    const m = validGenesisV2Ks256CborMap();
    await seedGenesisChainIdentity(e, m);
    interceptGenesisPost(logId, 409);
    interceptGenesisGet(logId, 500, "boom");

    const res = await postGenesis(e, logId, m);
    expect(res.status).toBe(503);
    expect(await e.R2_GRANTS.get(localGenesisKey(logId))).toBeNull();
  });

  it("exists with a local copy present: local byte-diff decides, no read-back", async () => {
    const e = envWithUnivocity();
    const logId = crypto.randomUUID();
    const m = validGenesisV2Ks256CborMap();
    await seedGenesisChainIdentity(e, m);
    // First post materialises the REAL local copy (created), then the same
    // request retries against a forward that now answers exists. No GET
    // interceptor: an unexpected read-back hits disableNetConnect and would
    // surface as a non-200.
    interceptGenesisPost(logId, 201);
    expect((await postGenesis(e, logId, m)).status).toBe(201);
    interceptGenesisPost(logId, 409);

    const res = await postGenesis(e, logId, m);
    expect(res.status).toBe(201);
  });

  it("cross-forest claim conflict (univocity 422) is rejected loudly", async () => {
    const e = envWithUnivocity();
    const logId = crypto.randomUUID();
    const m = validGenesisV2Ks256CborMap();
    await seedGenesisChainIdentity(e, m);
    fetchMock
      .get(UNIVOCITY_URL)
      .intercept({ path: `/api/forest/${logId}/genesis`, method: "POST" })
      .reply(422, "log id is claimed by another forest");

    const res = await postGenesis(e, logId, m);
    expect(res.status).toBe(400);
    expect(await e.R2_GRANTS.get(localGenesisKey(logId))).toBeNull();
  });
});
