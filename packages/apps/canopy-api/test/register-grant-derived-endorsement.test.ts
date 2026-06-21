/**
 * GF_DERIVED endorsement register-grant path: append on warm owner O when
 * endorsed root R' has no MMRS yet.
 */

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { Grant } from "../src/grant/types.js";
import { derivedEndorsementGrantFlags } from "../src/grant/grant-flags.js";
import { uuidToBytes } from "../src/grant/uuid-bytes.js";
import {
  registerGrant,
  type RegisterGrantEnv,
} from "../src/scrapi/register-grant.js";
import { COSE_ALG_ES256 } from "../src/cose/cose-key.js";
import { encodeCustodianProfileForestrieGrant } from "./helpers/custodian-transparent-grant.js";

const PARENT = "550e8400-e29b-41d4-a716-446655440000";
const CHILD = "111e4567-e89b-12d3-a456-426614174001";

const testState = vi.hoisted(() => ({
  bootstrapKey: new Uint8Array(64),
}));

vi.mock("../src/scrapi/log-initialized-mmrs.js", () => ({
  isLogInitializedMmrs: vi.fn(async (logId: string) => logId === PARENT),
}));

vi.mock("../src/forest/genesis-cache.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/forest/genesis-cache.js")>();
  return {
    ...actual,
    getParsedGenesis: vi.fn(async (segment: string) => {
      const { logIdToWireBytes } = await import("../src/grant/log-id-wire.js");
      try {
        const wire = logIdToWireBytes(segment);
        return {
          wire,
          schemaVersion: 2 as const,
          chainBinding: null,
          bootstrapAlg: COSE_ALG_ES256,
          bootstrapKey: testState.bootstrapKey,
        };
      } catch {
        return { kind: "bad_segment" as const };
      }
    }),
  };
});

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

let subjectPriv: CryptoKey;

function envWith(bootstrapLogId = PARENT): RegisterGrantEnv {
  return {
    queueEnv: {
      sequencingQueue: {} as DurableObjectNamespace,
      shardCountStr: "4",
    },
    bootstrapEnv: {
      bootstrapLogId,
      r2Grants: {} as R2Bucket,
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

function endorsementGrant(): Grant {
  return {
    logId: uuidToBytes(CHILD),
    ownerLogId: uuidToBytes(PARENT),
    grant: derivedEndorsementGrantFlags(),
    maxHeight: 0,
    minGrowth: 0,
    grantData: new Uint8Array(0),
  };
}

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
  testState.bootstrapKey =
    raw.length === 65 ? raw.slice(1, 65) : raw;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("registerGrant derived endorsement", () => {
  it("accepts GF_DERIVED leaf on warm owner when endorsed R' has no MMRS", async () => {
    const res = await registerGrant(
      new Request(`http://test/register/${PARENT}/grants`, {
        method: "POST",
        headers: {
          Authorization: await forestrieAuth(endorsementGrant(), subjectPriv),
        },
      }),
      envWith(),
    );
    expect(res.status).toBe(303);
  });

  it("rejects when endorser log is not MMRS-warm", async () => {
    const { isLogInitializedMmrs } = await import(
      "../src/scrapi/log-initialized-mmrs.js"
    );
    vi.mocked(isLogInitializedMmrs).mockResolvedValue(false);

    const res = await registerGrant(
      new Request(`http://test/register/${PARENT}/grants`, {
        method: "POST",
        headers: {
          Authorization: await forestrieAuth(endorsementGrant(), subjectPriv),
        },
      }),
      envWith(),
    );
    expect(res.status).toBe(403);
  });

  it("rejects when registered on wrong bootstrap path", async () => {
    const wrongParent = "660e8400-e29b-41d4-a716-446655440001";
    const res = await registerGrant(
      new Request(`http://test/register/${wrongParent}/grants`, {
        method: "POST",
        headers: {
          Authorization: await forestrieAuth(endorsementGrant(), subjectPriv),
        },
      }),
      envWith(wrongParent),
    );
    expect(res.status).toBe(403);
  });
});
