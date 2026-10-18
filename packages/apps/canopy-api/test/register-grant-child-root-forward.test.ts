/**
 * ADR-0053 Part A: after univocity accepts a child create grant, register-grant
 * forwards the child's public root to the coordinator. The grantData length
 * types the root (64 ES256, 20 KS256, else skip) and the forward carries the
 * forest's genesis chain binding — ADR-0053 amendment of 2026-10-18,
 * plan-2610-03 D2. The validator, genesis and sequencing are mocked as in
 * `register-grant-creation.test.ts`; keys are generated per test.
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
import { COSE_ALG_KS256 } from "../src/cose/cose-key.js";
import type { Grant } from "../src/grant/types.js";
import { uuidToBytes } from "../src/grant/uuid-bytes.js";
import {
  registerGrant,
  type RegisterGrantEnv,
} from "../src/scrapi/register-grant.js";
import { forestrieGrantAuthorizationHeader } from "./helpers/custodian-transparent-grant.js";
import { generateKs256TestKey } from "./helpers/ks256-forestrie-grant.js";

const PARENT = "550e8400-e29b-41d4-a716-446655440000";
const CHILD = "111e4567-e89b-12d3-a456-426614174001";
const COORDINATOR = "https://coordinator.test";
const CHAIN_ID = "84532";

vi.mock("../src/scrapi/log-initialized-mmrs.js", () => ({
  isLogInitializedMmrs: vi.fn(async () => false),
}));

vi.mock("../src/forest/genesis-cache.js", () => ({
  getParsedGenesis: vi.fn(async (segment: string) => {
    const { logIdToWireBytes } = await import("../src/grant/log-id-wire.js");
    return {
      wire: logIdToWireBytes(segment),
      x: new Uint8Array(32),
      y: new Uint8Array(32),
      schemaVersion: 1 as const,
      chainBinding: {
        address: new Uint8Array(20).fill(0x42),
        chainId: "84532",
      },
    };
  }),
}));

vi.mock("../src/scrapi/grant-sequencing.js", () => ({
  enqueueGrantForSequencing: vi.fn(async () => ({
    statusUrlPath: `/logs/${PARENT}/${PARENT}/entries/${"ab".repeat(32)}`,
    innerHex: "ab".repeat(32),
    ownerLogIdUuid: PARENT,
    alreadySequenced: false,
  })),
}));

let parentPriv: CryptoKey;
let forwarded: Array<Record<string, unknown>>;

beforeAll(async () => {
  const pair = (await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  parentPriv = pair.privateKey;
});

beforeEach(() => {
  forwarded = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (!url.startsWith(`${COORDINATOR}/api/logs/`)) {
        throw new Error(`unexpected fetch ${url}`);
      }
      forwarded.push(JSON.parse(String(init?.body)));
      return Response.json({ ok: true });
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function env(): RegisterGrantEnv {
  return {
    queueEnv: {
      sequencingQueue: {} as DurableObjectNamespace,
      shardCountStr: "4",
    },
    bootstrapEnv: {
      bootstrapLogId: PARENT,
      r2Grants: {} as R2Bucket,
      r2Mmrs: {} as R2Bucket,
      massifHeight: 14,
    },
    creationGrantValidator: {
      validate: async () => ({ kind: "accepted", created: true }),
    },
    coordinatorForward: {
      DELEGATION_COORDINATOR_URL: COORDINATOR,
      COORDINATOR_APP_TOKEN: "coordinator-token",
    },
  };
}

async function registerChild(grantData: Uint8Array): Promise<Response> {
  const flags = new Uint8Array(8);
  flags[3] = 0x03;
  flags[7] = 0x01;
  const grant: Grant = {
    logId: uuidToBytes(CHILD),
    ownerLogId: uuidToBytes(PARENT),
    grant: flags,
    maxHeight: 0,
    minGrowth: 0,
    grantData,
  };
  const request = new Request(`http://test/register/${PARENT}/grants`, {
    method: "POST",
    headers: {
      Authorization: await forestrieGrantAuthorizationHeader(
        grant,
        parentPriv,
        new Uint8Array(16).fill(0x42),
      ),
    },
  });
  return registerGrant(request, env());
}

const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const binding = { chainId: CHAIN_ID, univocityAddr: "42".repeat(20) };

describe("register-grant Part A child public-root forward", () => {
  it("forwards a 20-byte child as KS256 with the genesis chain binding", async () => {
    const child = generateKs256TestKey();

    const res = await registerChild(child.address);

    expect(res.status).toBe(303);
    expect(forwarded).toEqual([
      { alg: COSE_ALG_KS256, key: b64(child.address), chainBinding: binding },
    ]);
  });

  it("forwards a 64-byte child as ES256 with the genesis chain binding", async () => {
    const xy = crypto.getRandomValues(new Uint8Array(64));

    const res = await registerChild(xy);

    expect(res.status).toBe(303);
    expect(forwarded).toEqual([
      {
        alg: "ES256",
        x: b64(xy.slice(0, 32)),
        y: b64(xy.slice(32)),
        chainBinding: binding,
      },
    ]);
  });

  it("skips the forward for any other length and still registers", async () => {
    const res = await registerChild(new Uint8Array(33).fill(1));

    expect(res.status).toBe(303);
    expect(forwarded).toEqual([]);
  });
});
