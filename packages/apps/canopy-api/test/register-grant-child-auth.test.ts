/**
 * Child auth first grant (ARC-0017): uninitialized child logId, initialized parent ownerLogId,
 * Custodian-profile Sign1 verified against grantData x||y.
 */

import { beforeAll, describe, expect, it, vi } from "vitest";
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
        univocityAddr: null,
        chainIds: null,
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

function publicKeyToGrantData64(keyBytes: Uint8Array): Uint8Array {
  if (keyBytes.length === 64) return keyBytes;
  if (keyBytes.length === 65 && keyBytes[0] === 0x04)
    return keyBytes.slice(1, 65);
  throw new Error("invalid key length");
}

let subjectPriv: CryptoKey;
let subjectGrantData: Uint8Array;
let otherPriv: CryptoKey;

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
  subjectGrantData = publicKeyToGrantData64(new Uint8Array(rawExport));

  const pair2 = (await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  otherPriv = pair2.privateKey;
});

function baseEnv(): RegisterGrantEnv {
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
      custodianBootstrapAppToken: "bootstrap-token",
      r2Mmrs: {} as R2Bucket,
      massifHeight: 14,
    },
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

function childAuthGrant(overrides?: Partial<Grant>): Grant {
  return {
    logId: uuidToBytes(CHILD),
    ownerLogId: uuidToBytes(PARENT),
    grant: authFlags(),
    maxHeight: 0,
    minGrowth: 0,
    grantData: subjectGrantData,
    ...overrides,
  };
}

describe("registerGrant child auth first grant", () => {
  it("returns 303 when parent initialized, signature matches grantData", async () => {
    const grant = childAuthGrant();
    const request = new Request(`http://test/register/${PARENT}/grants`, {
      method: "POST",
      headers: { Authorization: await forestrieAuth(grant, subjectPriv) },
    });
    const res = await registerGrant(request, baseEnv());
    expect(res.status).toBe(303);
    expect(res.headers.get("Location")).toContain(
      `/logs/${PARENT}/${PARENT}/entries/`,
    );
  });

  it("returns 403 when COSE signer does not match grantData", async () => {
    const grant = childAuthGrant();
    const request = new Request(`http://test/register/${PARENT}/grants`, {
      method: "POST",
      headers: { Authorization: await forestrieAuth(grant, otherPriv) },
    });
    const res = await registerGrant(request, baseEnv());
    expect(res.status).toBe(403);
  });

  it("returns 403 when grantData is not 64-byte ES256 x||y", async () => {
    const grant = childAuthGrant({
      grantData: new Uint8Array(16),
    });
    const request = new Request(`http://test/register/${PARENT}/grants`, {
      method: "POST",
      headers: { Authorization: await forestrieAuth(grant, subjectPriv) },
    });
    const res = await registerGrant(request, baseEnv());
    expect(res.status).toBe(403);
  });

  it("returns 303 for GF_DATA_LOG child first grant (child data path)", async () => {
    const flags = new Uint8Array(8);
    flags[4] = 0x03;
    flags[7] = 0x02;
    const grant = childAuthGrant({ grant: flags });
    const request = new Request(`http://test/register/${PARENT}/grants`, {
      method: "POST",
      headers: { Authorization: await forestrieAuth(grant, subjectPriv) },
    });
    const res = await registerGrant(request, baseEnv());
    expect(res.status).toBe(303);
    expect(res.headers.get("Location")).toContain(
      `/logs/${PARENT}/${PARENT}/entries/`,
    );
  });

  it("returns 403 for child data first grant when signer does not match grantData", async () => {
    const flags = new Uint8Array(8);
    flags[4] = 0x03;
    flags[7] = 0x02;
    const grant = childAuthGrant({ grant: flags });
    const request = new Request(`http://test/register/${PARENT}/grants`, {
      method: "POST",
      headers: { Authorization: await forestrieAuth(grant, otherPriv) },
    });
    const res = await registerGrant(request, baseEnv());
    expect(res.status).toBe(403);
  });
});

describe("registerGrant child auth first grant parent not initialized", () => {
  it("returns 403 when parent has no MMRS", async () => {
    const { isLogInitializedMmrs } = await import(
      "../src/scrapi/log-initialized-mmrs.js"
    );
    vi.mocked(isLogInitializedMmrs).mockImplementation(async () => false);

    const grant = childAuthGrant();
    const request = new Request(`http://test/register/${PARENT}/grants`, {
      method: "POST",
      headers: { Authorization: await forestrieAuth(grant, subjectPriv) },
    });
    const res = await registerGrant(request, baseEnv());
    expect(res.status).toBe(403);
    const buf = new Uint8Array(await res.arrayBuffer());
    const { decode } = await import("cbor-x");
    const body = decode(buf) as { detail?: string };
    expect(body.detail).toContain(
      "bootstrap the root before child auth grants",
    );

    vi.mocked(isLogInitializedMmrs).mockImplementation(
      async (logId: string) => {
        return logId === PARENT;
      },
    );
  });
});
