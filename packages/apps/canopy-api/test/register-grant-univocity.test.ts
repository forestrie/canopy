/**
 * Univocity delegation path (plan-0029): when `env.univocity` is configured,
 * canopy delegates creation-grant validation to univocity `POST /api/grants`
 * and surfaces its 201/200 -> 303, 409 -> 409, 4xx -> 403 decisions. The local
 * first-grant verification is bypassed (univocity is the authority).
 */

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { Grant } from "../src/grant/types.js";
import { uuidToBytes } from "../src/grant/uuid-bytes.js";
import {
  registerGrant,
  type RegisterGrantEnv,
} from "../src/scrapi/register-grant.js";
import { encodeCustodianProfileForestrieGrant } from "./helpers/custodian-transparent-grant.js";

const PARENT = "550e8400-e29b-41d4-a716-446655440000";
const CHILD = "111e4567-e89b-12d3-a456-426614174001";

vi.mock("../src/scrapi/log-initialized-mmrs.js", () => ({
  isLogInitializedMmrs: vi.fn(async (logId: string) => logId === PARENT),
}));

vi.mock("../src/forest/genesis-cache.js", () => ({
  getParsedGenesis: vi.fn(async (segment: string) => {
    const { logIdToWireBytes } = await import("../src/grant/log-id-wire.js");
    try {
      const wire = logIdToWireBytes(segment);
      return {
        wire,
        x: new Uint8Array(32),
        y: new Uint8Array(32),
        schemaVersion: 0 as const,
        chainBinding: null,
      };
    } catch {
      return { kind: "bad_segment" as const };
    }
  }),
}));

vi.mock("../src/scrapi/grant-sequencing.js", () => ({
  enqueueGrantForSequencing: vi.fn(async () => ({
    statusUrlPath: `/logs/${PARENT}/${PARENT}/entries/abcd0000abcd0000abcd0000abcd0000abcd0000abcd0000abcd0000abcd0000`,
    innerHex:
      "abcd0000abcd0000abcd0000abcd0000abcd0000abcd0000abcd0000abcd0000",
    ownerLogIdUuid: PARENT,
    alreadySequenced: false,
  })),
}));

const TEST_KID = new Uint8Array(16).fill(0x42);

function authFlags(): Uint8Array {
  const g = new Uint8Array(8);
  g[4] = 0x03;
  g[7] = 0x01;
  return g;
}

let subjectPriv: CryptoKey;
let subjectGrantData: Uint8Array;

beforeAll(async () => {
  const pair = (await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  subjectPriv = pair.privateKey;
  const rawExport = (await crypto.subtle.exportKey(
    "raw",
    pair.publicKey,
  )) as ArrayBuffer;
  const raw = new Uint8Array(rawExport);
  subjectGrantData = raw.length === 65 ? raw.slice(1, 65) : raw;
});

afterEach(() => {
  vi.restoreAllMocks();
});

function envWithUnivocity(): RegisterGrantEnv {
  return {
    queueEnv: {
      sequencingQueue: {} as DurableObjectNamespace,
      shardCountStr: "4",
    },
    bootstrapEnv: {
      bootstrapLogId: PARENT,
      r2Grants: {} as R2Bucket,
      custodianUrl: "https://custodian.test",
      custodianAppToken: "",
      r2Mmrs: {} as R2Bucket,
      massifHeight: 14,
    },
    univocity: { serviceUrl: "https://univocity.test", token: "tok" },
  };
}

async function forestrieAuth(grant: Grant, priv: CryptoKey): Promise<string> {
  const bytes = await encodeCustodianProfileForestrieGrant(
    grant,
    priv,
    TEST_KID,
    new Uint8Array(8),
  );
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]!);
  return `Forestrie-Grant ${btoa(s)}`;
}

function childAuthGrant(): Grant {
  return {
    logId: uuidToBytes(CHILD),
    ownerLogId: uuidToBytes(PARENT),
    grant: authFlags(),
    maxHeight: 0,
    minGrowth: 0,
    grantData: subjectGrantData,
  };
}

async function runWithUnivocityStatus(status: number): Promise<Response> {
  const fetchSpy = vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValue(new Response(new Uint8Array(), { status }));
  const grant = childAuthGrant();
  const request = new Request(`http://test/register/${PARENT}/grants`, {
    method: "POST",
    headers: { Authorization: await forestrieAuth(grant, subjectPriv) },
  });
  const res = await registerGrant(request, envWithUnivocity());
  expect(fetchSpy).toHaveBeenCalledOnce();
  const url = fetchSpy.mock.calls[0]![0] as string;
  expect(url).toBe("https://univocity.test/api/grants");
  return res;
}

describe("registerGrant univocity delegation", () => {
  it("201 from univocity -> 303 (enqueued)", async () => {
    const res = await runWithUnivocityStatus(201);
    expect(res.status).toBe(303);
  });

  it("200 from univocity -> 303 (idempotent enqueue)", async () => {
    const res = await runWithUnivocityStatus(200);
    expect(res.status).toBe(303);
  });

  it("409 from univocity -> 409 (cross-forest logId reuse)", async () => {
    const res = await runWithUnivocityStatus(409);
    expect(res.status).toBe(409);
  });

  it("422 from univocity -> 403 (invalid grant chain)", async () => {
    const res = await runWithUnivocityStatus(422);
    expect(res.status).toBe(403);
  });

  it("503 from univocity -> 503 (validation unavailable)", async () => {
    const res = await runWithUnivocityStatus(503);
    expect(res.status).toBe(503);
  });
});
