/**
 * ADR-0053 Part B (`POST /api/forest/{childLogId}/prepare`) with KS256 child
 * roots and KS256 parents — the ADR-0053 amendment of 2026-10-18 and
 * plan-2610-03 decisions D2, D3 and D6.
 *
 * The genesis store and the parent registration are mocked; the coordinator and
 * the chain's JSON-RPC are a stubbed `fetch`. Every key and signature is made
 * here, and the "Safe" is a mocked ERC-1271 contract whose owner is a fresh
 * secp256k1 key.
 */

import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { encodeCborDeterministic } from "@forestrie/encoding";
import { COSE_ALG_ES256, COSE_ALG_KS256 } from "../src/cose/cose-key.js";
import { resetSupportedChainsCacheForTests } from "../src/env/supported-chains-for-env.js";
import { handlePrepareChildLog } from "../src/forest/prepare-child-log.js";
import type { ParsedForestGenesis } from "../src/forest/parsed-forest-genesis.js";
import { logIdToStorageSegment } from "../src/grant/log-id-wire.js";
import type { Grant } from "../src/grant/types.js";
import { uuidToBytes } from "../src/grant/uuid-bytes.js";
import { forestrieGrantAuthorizationHeader } from "./helpers/custodian-transparent-grant.js";
import {
  generateKs256TestKey,
  ks256ForestrieGrantAuthorization,
  mockErc1271Rpc,
  type Ks256TestKey,
} from "./helpers/ks256-forestrie-grant.js";

const ROOT = "550e8400-e29b-41d4-a716-446655440000";
const PARENT = "660e8400-e29b-41d4-a716-446655440001";
const CHILD = "111e4567-e89b-12d3-a456-426614174001";
const COORDINATOR = "https://coordinator.test";
const RPC_URL = "https://rpc.test";
const CHAIN_ID = "84532";
const UNIVOCITY_ADDR = new Uint8Array(20).fill(0x42);
const UNIVOCITY_ADDR_HEX = "42".repeat(20);

const seg = (uuid: string) => logIdToStorageSegment(uuidToBytes(uuid));

const state = vi.hoisted(() => ({
  genesis: new Map<string, unknown>(),
}));

vi.mock("../src/forest/genesis-cache.js", () => ({
  getParsedGenesis: vi.fn(
    async (segment: string) =>
      state.genesis.get(segment) ?? { kind: "not_found" as const },
  ),
}));

vi.mock("../src/payments/registration-store.js", () => ({
  readRegistration: vi.fn(async () => null),
}));

interface StubbedRoot {
  alg: number;
  key: Uint8Array;
  chainId?: string;
}

/** Coordinator public roots by API log-id segment, and what was POSTed. */
let coordinatorRoots: Map<string, StubbedRoot>;
let forwarded: Array<{ logSeg: string; body: Record<string, unknown> }>;
let rpc: ((body: { method: string; params: unknown[] }) => unknown) | null;
let rpcCalls: string[];

function stubFetch(): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === RPC_URL) {
        const body = JSON.parse(String(init?.body)) as {
          method: string;
          params: unknown[];
        };
        rpcCalls.push(body.method);
        if (!rpc) return new Response("down", { status: 502 });
        return Response.json({ jsonrpc: "2.0", id: 1, result: rpc(body) });
      }
      const m = url.match(/\/api\/logs\/([^/]+)\/public-root$/);
      if (!m || !url.startsWith(COORDINATOR)) {
        throw new Error(`unexpected fetch ${url}`);
      }
      if ((init?.method ?? "GET") === "POST") {
        forwarded.push({
          logSeg: m[1]!,
          body: JSON.parse(String(init?.body)) as Record<string, unknown>,
        });
        return Response.json({ ok: true });
      }
      const root = coordinatorRoots.get(m[1]!);
      if (!root) return new Response(null, { status: 404 });
      return new Response(
        encodeCborDeterministic({
          logId: uuidToBytes(PARENT),
          alg: root.alg,
          key: root.key,
          ...(root.chainId ? { chainId: root.chainId } : {}),
        }),
        { status: 200, headers: { "Content-Type": "application/cbor" } },
      );
    }),
  );
}

let es256Parent: { priv: CryptoKey; xy: Uint8Array };

beforeAll(async () => {
  const pair = (await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const raw = new Uint8Array(
    (await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer,
  );
  es256Parent = { priv: pair.privateKey, xy: raw.slice(1, 65) };
});

beforeEach(() => {
  state.genesis.clear();
  coordinatorRoots = new Map();
  forwarded = [];
  rpc = null;
  rpcCalls = [];
  resetSupportedChainsCacheForTests();
  stubFetch();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function createFlags(): Uint8Array {
  const g = new Uint8Array(8);
  g[3] = 0x03;
  g[7] = 0x01;
  return g;
}

function childGrant(owner: string, grantData: Uint8Array): Grant {
  return {
    logId: uuidToBytes(CHILD),
    ownerLogId: uuidToBytes(owner),
    grant: createFlags(),
    maxHeight: 0,
    minGrowth: 0,
    grantData,
  };
}

function rootGenesis(alg: number, key: Uint8Array): ParsedForestGenesis {
  return {
    wire: uuidToBytes(ROOT),
    schemaVersion: 2,
    chainBinding: { address: UNIVOCITY_ADDR, chainId: CHAIN_ID },
    bootstrapAlg: alg,
    bootstrapKey: key,
  };
}

function env(opts: { rpc?: boolean } = {}) {
  return {
    DELEGATION_COORDINATOR_URL: COORDINATOR,
    COORDINATOR_APP_TOKEN: "coordinator-token",
    R2_GRANTS: {} as R2Bucket,
    ...(opts.rpc
      ? { SUPPORTED_CHAINS_RPC: JSON.stringify({ [CHAIN_ID]: [RPC_URL] }) }
      : {}),
  };
}

async function prepare(
  authorization: string,
  opts: { rpc?: boolean } = {},
): Promise<Response> {
  const request = new Request(`http://test/api/forest/${CHILD}/prepare`, {
    method: "POST",
    headers: { Authorization: authorization },
  });
  return handlePrepareChildLog(request, CHILD, env(opts));
}

const es256Auth = (grant: Grant) =>
  forestrieGrantAuthorizationHeader(
    grant,
    es256Parent.priv,
    new Uint8Array(16).fill(0x42),
  );

function b64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

describe("prepare: KS256 child roots (D2)", () => {
  it("forwards a 20-byte child as KS256 with the forest's genesis chain binding", async () => {
    state.genesis.set(seg(ROOT), rootGenesis(COSE_ALG_ES256, es256Parent.xy));
    const child = generateKs256TestKey();

    const res = await prepare(await es256Auth(childGrant(ROOT, child.address)));

    expect(res.status).toBe(201);
    expect(forwarded).toEqual([
      {
        logSeg: seg(CHILD),
        body: {
          alg: COSE_ALG_KS256,
          key: b64(child.address),
          chainBinding: {
            chainId: CHAIN_ID,
            univocityAddr: UNIVOCITY_ADDR_HEX,
          },
        },
      },
    ]);
  });

  it("forwards a 64-byte child as ES256, now also carrying the chain binding", async () => {
    state.genesis.set(seg(ROOT), rootGenesis(COSE_ALG_ES256, es256Parent.xy));
    const childXy = crypto.getRandomValues(new Uint8Array(64));

    const res = await prepare(await es256Auth(childGrant(ROOT, childXy)));

    expect(res.status).toBe(201);
    expect(forwarded[0]!.body).toEqual({
      alg: "ES256",
      x: b64(childXy.slice(0, 32)),
      y: b64(childXy.slice(32)),
      chainBinding: { chainId: CHAIN_ID, univocityAddr: UNIVOCITY_ADDR_HEX },
    });
  });

  it("refuses grantData that is neither 64 nor 20 bytes (400)", async () => {
    state.genesis.set(seg(ROOT), rootGenesis(COSE_ALG_ES256, es256Parent.xy));

    const res = await prepare(
      await es256Auth(childGrant(ROOT, new Uint8Array(33).fill(1))),
    );

    expect(res.status).toBe(400);
    expect(forwarded).toHaveLength(0);
  });
});

describe("prepare: KS256 parent at the forest root (D3)", () => {
  let parent: Ks256TestKey;
  beforeEach(() => {
    parent = generateKs256TestKey();
  });

  it("accepts an EOA root's grant by ecrecover, without RPC", async () => {
    state.genesis.set(seg(ROOT), rootGenesis(COSE_ALG_KS256, parent.address));
    const child = generateKs256TestKey();

    const res = await prepare(
      ks256ForestrieGrantAuthorization(childGrant(ROOT, child.address), parent),
    );

    expect(res.status).toBe(201);
    expect(rpcCalls).toEqual([]);
    expect(forwarded[0]!.body.alg).toBe(COSE_ALG_KS256);
  });

  it("refuses a grant signed by another key (403)", async () => {
    state.genesis.set(seg(ROOT), rootGenesis(COSE_ALG_KS256, parent.address));

    const res = await prepare(
      ks256ForestrieGrantAuthorization(
        childGrant(ROOT, generateKs256TestKey().address),
        generateKs256TestKey(),
      ),
    );

    expect(res.status).toBe(403);
    expect(forwarded).toHaveLength(0);
  });

  it("accepts a Safe root's grant by ERC-1271 on the genesis chain", async () => {
    const safe = generateKs256TestKey().address;
    state.genesis.set(seg(ROOT), rootGenesis(COSE_ALG_KS256, safe));
    rpc = mockErc1271Rpc({ contract: safe, owner: parent.address });

    const res = await prepare(
      ks256ForestrieGrantAuthorization(
        childGrant(ROOT, generateKs256TestKey().address),
        parent,
      ),
      { rpc: true },
    );

    expect(res.status).toBe(201);
    expect(rpcCalls).toEqual(["eth_getCode", "eth_call"]);
  });

  it("refuses a Safe root's grant from a non-owner (403)", async () => {
    const safe = generateKs256TestKey().address;
    state.genesis.set(seg(ROOT), rootGenesis(COSE_ALG_KS256, safe));
    rpc = mockErc1271Rpc({ contract: safe, owner: parent.address });

    const res = await prepare(
      ks256ForestrieGrantAuthorization(
        childGrant(ROOT, generateKs256TestKey().address),
        generateKs256TestKey(),
      ),
      { rpc: true },
    );

    expect(res.status).toBe(403);
    expect(forwarded).toHaveLength(0);
  });

  it("answers 503 when the chain RPC fails", async () => {
    const safe = generateKs256TestKey().address;
    state.genesis.set(seg(ROOT), rootGenesis(COSE_ALG_KS256, safe));
    rpc = null; // the stubbed endpoint answers 502

    const res = await prepare(
      ks256ForestrieGrantAuthorization(
        childGrant(ROOT, generateKs256TestKey().address),
        parent,
      ),
      { rpc: true },
    );

    expect(res.status).toBe(503);
    expect(forwarded).toHaveLength(0);
  });

  it("refuses a Safe root with no RPC for its chain, saying why (403)", async () => {
    const safe = generateKs256TestKey().address;
    state.genesis.set(seg(ROOT), rootGenesis(COSE_ALG_KS256, safe));

    const res = await prepare(
      ks256ForestrieGrantAuthorization(
        childGrant(ROOT, generateKs256TestKey().address),
        parent,
      ),
    );

    expect(res.status).toBe(403);
    expect(await res.text()).toContain(
      `No RPC is configured for chain ${CHAIN_ID}`,
    );
  });
});

describe("prepare: KS256 intermediate parent (D2, D3)", () => {
  let parent: Ks256TestKey;
  beforeEach(() => {
    parent = generateKs256TestKey();
  });

  it("accepts an EOA parent and forwards the child with the parent's chain", async () => {
    coordinatorRoots.set(seg(PARENT), {
      alg: COSE_ALG_KS256,
      key: parent.address,
      chainId: CHAIN_ID,
    });
    const child = generateKs256TestKey();

    const res = await prepare(
      ks256ForestrieGrantAuthorization(
        childGrant(PARENT, child.address),
        parent,
      ),
    );

    expect(res.status).toBe(201);
    expect(forwarded[0]!.body).toEqual({
      alg: COSE_ALG_KS256,
      key: b64(child.address),
      chainBinding: { chainId: CHAIN_ID },
    });
  });

  it("accepts a Safe parent by ERC-1271 on the chain the coordinator holds", async () => {
    const safe = generateKs256TestKey().address;
    coordinatorRoots.set(seg(PARENT), {
      alg: COSE_ALG_KS256,
      key: safe,
      chainId: CHAIN_ID,
    });
    rpc = mockErc1271Rpc({ contract: safe, owner: parent.address });

    const res = await prepare(
      ks256ForestrieGrantAuthorization(
        childGrant(PARENT, generateKs256TestKey().address),
        parent,
      ),
      { rpc: true },
    );

    expect(res.status).toBe(201);
    expect(rpcCalls).toEqual(["eth_getCode", "eth_call"]);
  });

  it("refuses a Safe parent whose root has no chain, saying why (403)", async () => {
    const safe = generateKs256TestKey().address;
    coordinatorRoots.set(seg(PARENT), { alg: COSE_ALG_KS256, key: safe });
    rpc = mockErc1271Rpc({ contract: safe, owner: parent.address });

    const res = await prepare(
      ks256ForestrieGrantAuthorization(
        childGrant(PARENT, generateKs256TestKey().address),
        parent,
      ),
      { rpc: true },
    );

    expect(res.status).toBe(403);
    expect(await res.text()).toContain("none is registered for its root");
    expect(rpcCalls).toEqual([]);
  });

  it("an ES256 intermediate parent passes its chain to a KS256 child", async () => {
    coordinatorRoots.set(seg(PARENT), {
      alg: COSE_ALG_ES256,
      key: es256Parent.xy,
      chainId: CHAIN_ID,
    });
    const child = generateKs256TestKey();

    const res = await prepare(
      await es256Auth(childGrant(PARENT, child.address)),
    );

    expect(res.status).toBe(201);
    expect(forwarded[0]!.body.chainBinding).toEqual({ chainId: CHAIN_ID });
  });
});

describe("prepare: the alg decides and the length must agree (D6)", () => {
  it("refuses a genesis whose KS256 bootstrapAlg carries a 64-byte key", async () => {
    state.genesis.set(seg(ROOT), rootGenesis(COSE_ALG_KS256, es256Parent.xy));

    const res = await prepare(
      await es256Auth(childGrant(ROOT, generateKs256TestKey().address)),
    );

    expect(res.status).toBe(403);
    expect(forwarded).toHaveLength(0);
  });

  it("refuses a genesis whose ES256 bootstrapAlg carries a 20-byte key", async () => {
    const parent = generateKs256TestKey();
    state.genesis.set(seg(ROOT), rootGenesis(COSE_ALG_ES256, parent.address));

    const res = await prepare(
      ks256ForestrieGrantAuthorization(
        childGrant(ROOT, generateKs256TestKey().address),
        parent,
      ),
    );

    expect(res.status).toBe(403);
    expect(forwarded).toHaveLength(0);
  });

  it("does not accept a coordinator root whose KS256 alg carries a 64-byte key", async () => {
    coordinatorRoots.set(seg(PARENT), {
      alg: COSE_ALG_KS256,
      key: es256Parent.xy,
      chainId: CHAIN_ID,
    });

    const res = await prepare(
      await es256Auth(childGrant(PARENT, generateKs256TestKey().address)),
    );

    // The trust-root decode refuses it; prepare reports the resolve failure.
    expect(res.status).toBe(503);
    expect(forwarded).toHaveLength(0);
  });
});
