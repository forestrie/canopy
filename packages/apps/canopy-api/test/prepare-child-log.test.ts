/**
 * `POST /api/forest/{childLogId}/prepare` claims the child through univocity
 * before anything reaches the delegation coordinator (devdocs ADR-0075
 * decisions 1-3). univocity verifies the create grant against the owner's
 * key and reserves the child; prepare forwards the child's root only on
 * success, with the reservation's lapse time, so the coordinator's root lapses
 * with it. Child roots may be 64-byte ES256 keys or 20-byte KS256 addresses
 * (ADR-0053 amendment 2026-10-18); either way the forward carries the forest's
 * chain, from univocity's answer for the owner.
 *
 * univocity's grant endpoint and the coordinator are a stubbed `fetch`; the
 * owner's authority comes through the {@link LogAuthorityReader} seam.
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
import type { LogAuthority } from "../src/env/log-authority.js";
import { handlePrepareChildLog } from "../src/forest/prepare-child-log.js";
import { logIdToStorageSegment } from "../src/grant/log-id-wire.js";
import type { Grant } from "../src/grant/types.js";
import { uuidToBytes } from "../src/grant/uuid-bytes.js";
import { decodeCborAsObject } from "./helpers/cbor-decode-object.js";
import { forestrieGrantAuthorizationHeader } from "./helpers/custodian-transparent-grant.js";
import { readerAnswering } from "./helpers/log-authority-stub.js";

const PARENT = "660e8400-e29b-41d4-a716-446655440001";
const CHILD = "111e4567-e89b-12d3-a456-426614174001";
const COORDINATOR = "https://coordinator.test";
const UNIVOCITY = "https://univocity.test";
const CHAIN_ID = "84532";
const EXPIRES_AT = 1_900_000_000;

vi.mock("../src/payments/registration-store.js", () => ({
  readRegistration: vi.fn(async () => null),
}));

/** What univocity answers the next claim with: [status, body]. */
let claimAnswer: [number, Record<string, unknown> | string];
let claims: Array<Record<string, unknown>>;
let coordinatorStatus: number;
let forwarded: Array<{ logSeg: string; body: Record<string, unknown> }>;

function stubFetch(): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === `${UNIVOCITY}/api/grants`) {
        claims.push(
          decodeCborAsObject(
            new Uint8Array(init!.body as ArrayBuffer),
          ) as Record<string, unknown>,
        );
        const [status, body] = claimAnswer;
        return typeof body === "string"
          ? new Response(body, { status })
          : new Response(encodeCborDeterministic(body) as unknown as BodyInit, {
              status,
              headers: { "Content-Type": "application/cbor" },
            });
      }
      const m = url.match(/\/api\/logs\/([^/]+)\/public-root$/);
      if (!m || !url.startsWith(COORDINATOR) || init?.method !== "POST") {
        throw new Error(`unexpected fetch ${init?.method ?? "GET"} ${url}`);
      }
      forwarded.push({
        logSeg: m[1]!,
        body: JSON.parse(String(init.body)) as Record<string, unknown>,
      });
      return Response.json({ ok: true }, { status: coordinatorStatus });
    }),
  );
}

let parentKey: CryptoKey;

beforeAll(async () => {
  const pair = (await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  parentKey = pair.privateKey;
});

beforeEach(() => {
  claimAnswer = [201, { state: "reserved", expiresAt: EXPIRES_AT }];
  claims = [];
  coordinatorStatus = 200;
  forwarded = [];
  stubFetch();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function childGrant(grantData: Uint8Array): Grant {
  const flags = new Uint8Array(8);
  flags[3] = 0x03; // GF_CREATE | GF_EXTEND
  flags[7] = 0x01; // auth log
  return {
    logId: uuidToBytes(CHILD),
    ownerLogId: uuidToBytes(PARENT),
    grant: flags,
    maxHeight: 0,
    minGrowth: 0,
    grantData,
  };
}

const PENDING_OWNER: LogAuthority = {
  kind: "pending",
  state: "sequenced",
  chainId: CHAIN_ID,
};

const ANCHORED_OWNER: LogAuthority = {
  kind: "anchored",
  final: true,
  alg: -7,
  key: new Uint8Array(64),
  chainId: CHAIN_ID,
};

async function prepare(
  grantData: Uint8Array,
  owner: LogAuthority = ANCHORED_OWNER,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const authorization = await forestrieGrantAuthorizationHeader(
    childGrant(grantData),
    parentKey,
    new Uint8Array(16).fill(0x42),
  );
  const request = new Request(`http://test/api/forest/${CHILD}/prepare`, {
    method: "POST",
    headers: { Authorization: authorization },
  });
  const res = await handlePrepareChildLog(request, CHILD, {
    DELEGATION_COORDINATOR_URL: COORDINATOR,
    COORDINATOR_APP_TOKEN: "coordinator-token",
    UNIVOCITY_SERVICE_URL: UNIVOCITY,
    UNIVOCITY_API_TOKEN: "univocity-token",
    logAuthority: readerAnswering(owner).reader,
    R2_GRANTS: {} as R2Bucket,
  });
  const bytes = new Uint8Array(await res.arrayBuffer());
  return {
    status: res.status,
    body:
      bytes.length > 0
        ? (decodeCborAsObject(bytes) as Record<string, unknown>)
        : {},
  };
}

const ks256Child = () => new Uint8Array(20).fill(0x5c);
const es256Child = () => new Uint8Array(64).fill(0x07);

describe("prepare claims the child through univocity first", () => {
  it("reserves, then forwards a KS256 child with the reservation's lapse time and the forest's chain", async () => {
    const r = await prepare(ks256Child());

    expect(r.status).toBe(201);
    expect(r.body.expiresAt).toBe(EXPIRES_AT);
    expect(claims).toHaveLength(1);
    expect(claims[0]!.intent).toBe("reserve");
    expect(forwarded).toHaveLength(1);
    expect(forwarded[0]!.logSeg).toBe(
      logIdToStorageSegment(uuidToBytes(CHILD)),
    );
    expect(forwarded[0]!.body).toMatchObject({
      alg: -65799,
      expiresAt: EXPIRES_AT,
      chainBinding: { chainId: CHAIN_ID },
    });
  });

  it("forwards a 64-byte child as ES256", async () => {
    const r = await prepare(es256Child());

    expect(r.status).toBe(201);
    expect(forwarded[0]!.body).toMatchObject({
      alg: "ES256",
      expiresAt: EXPIRES_AT,
    });
  });

  it("is allowed under a pending owner, and returns expiresAt", async () => {
    const r = await prepare(es256Child(), PENDING_OWNER);

    expect(r.status).toBe(201);
    expect(r.body.expiresAt).toBe(EXPIRES_AT);
    expect(forwarded).toHaveLength(1);
  });

  it("refuses grantData that is neither 64 nor 20 bytes (400) before claiming", async () => {
    const r = await prepare(new Uint8Array(33));

    expect(r.status).toBe(400);
    expect(claims).toHaveLength(0);
    expect(forwarded).toHaveLength(0);
  });

  it("a grant by an owner who does not own the child is refused, and the coordinator is untouched", async () => {
    claimAnswer = [
      422,
      JSON.stringify({
        type: "about:blank",
        title: "grant chain invalid",
        status: 422,
      }),
    ];
    const r = await prepare(es256Child());

    expect(r.status).toBe(403);
    expect(forwarded).toHaveLength(0);
  });

  it("a different root key for a claimed child gets univocity's 409, and the coordinator is untouched", async () => {
    claimAnswer = [
      409,
      JSON.stringify({
        type: "about:blank",
        title: "grant-already-claimed",
        status: 409,
      }),
    ];
    const r = await prepare(es256Child());

    expect(r.status).toBe(409);
    expect(String(r.body.detail)).toContain("grant-already-claimed");
    expect(forwarded).toHaveLength(0);
  });

  it("the same grant again gets 200 and refreshes the forward", async () => {
    claimAnswer = [200, { state: "reserved", expiresAt: EXPIRES_AT + 60 }];
    const r = await prepare(es256Child());

    expect(r.status).toBe(200);
    expect(r.body.expiresAt).toBe(EXPIRES_AT + 60);
    expect(forwarded[0]!.body.expiresAt).toBe(EXPIRES_AT + 60);
  });

  it("a grant already committed by create forwards a permanent root", async () => {
    claimAnswer = [200, { state: "committed" }];
    const r = await prepare(es256Child());

    expect(r.status).toBe(200);
    expect(r.body.expiresAt).toBeUndefined();
    expect(forwarded[0]!.body.expiresAt).toBeUndefined();
  });

  it("refuses an owner that is conflicted with 409 authority-conflict, before claiming", async () => {
    const r = await prepare(es256Child(), { kind: "conflicted" });

    expect(r.status).toBe(409);
    expect(r.body.type).toBe("authority-conflict");
    expect(claims).toHaveLength(0);
    expect(forwarded).toHaveLength(0);
  });

  it("refuses an owner univocity holds no claim for (409), before claiming", async () => {
    const r = await prepare(es256Child(), { kind: "unclaimed" });

    expect(r.status).toBe(409);
    expect(claims).toHaveLength(0);
  });

  it("answers 503 when univocity is unavailable, and forwards nothing", async () => {
    claimAnswer = [503, "down"];
    const r = await prepare(es256Child());

    expect(r.status).toBe(503);
    expect(forwarded).toHaveLength(0);
  });

  it("passes the coordinator's 409 for a different stored root back", async () => {
    coordinatorStatus = 409;
    const r = await prepare(es256Child());

    expect(r.status).toBe(409);
  });
});
