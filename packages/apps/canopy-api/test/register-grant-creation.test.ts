/**
 * Creation-grant path (plan-0029): an uninitialized target log is opened by a
 * creation grant whose validation is delegated to the {@link CreationGrantValidator}
 * seam. These tests inject a *mock* validator so the whole register-grant flow is
 * exercised without HTTP or local crypto, and assert the validator decision ->
 * HTTP status mapping (accepted -> 303, conflict -> 409, rejected -> 403,
 * unavailable -> 503) plus the no-validator (503) and wrong-shape (403) guards.
 * The univocity HTTP status mapping itself is covered in
 * `univocity-grant-client.test.ts`.
 */

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { Grant } from "../src/grant/types.js";
import { uuidToBytes } from "../src/grant/uuid-bytes.js";
import {
  registerGrant,
  type RegisterGrantEnv,
} from "../src/scrapi/register-grant.js";
import type {
  CreationGrantValidator,
  UnivocityGrantResult,
} from "../src/scrapi/univocity-grant-client.js";
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

/** Mock validator: returns a fixed decision and records what it was asked to validate. */
function mockValidator(decision: UnivocityGrantResult): {
  validator: CreationGrantValidator;
  calls: Array<{ rootWire: Uint8Array; statementBytes: Uint8Array }>;
} {
  const calls: Array<{ rootWire: Uint8Array; statementBytes: Uint8Array }> = [];
  return {
    calls,
    validator: {
      validate: async (rootWire, statementBytes) => {
        calls.push({ rootWire, statementBytes });
        return decision;
      },
    },
  };
}

function envWith(
  creationGrantValidator?: CreationGrantValidator,
): RegisterGrantEnv {
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
    creationGrantValidator,
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

function creationGrant(grantFlags: Uint8Array = authFlags()): Grant {
  return {
    logId: uuidToBytes(CHILD),
    ownerLogId: uuidToBytes(PARENT),
    grant: grantFlags,
    maxHeight: 0,
    minGrowth: 0,
    grantData: subjectGrantData,
  };
}

async function register(
  env: RegisterGrantEnv,
  grant: Grant = creationGrant(),
): Promise<Response> {
  const request = new Request(`http://test/register/${PARENT}/grants`, {
    method: "POST",
    headers: { Authorization: await forestrieAuth(grant, subjectPriv) },
  });
  return registerGrant(request, env);
}

describe("registerGrant creation-grant delegation", () => {
  it("accepted -> 303 and forwards (rootWire, statement) to the validator", async () => {
    const { validator, calls } = mockValidator({
      kind: "accepted",
      created: true,
    });
    const res = await register(envWith(validator));
    expect(res.status).toBe(303);
    expect(calls).toHaveLength(1);
    // rootWire is the forest root R derived from the bootstrap-logid path segment.
    expect(calls[0]!.rootWire.length).toBe(16);
    expect(calls[0]!.statementBytes.length).toBeGreaterThan(0);
  });

  it("idempotent accepted (created=false) -> 303", async () => {
    const { validator } = mockValidator({ kind: "accepted", created: false });
    const res = await register(envWith(validator));
    expect(res.status).toBe(303);
  });

  it("conflict -> 409 (cross-forest logId reuse)", async () => {
    const { validator } = mockValidator({
      kind: "conflict",
      detail: "logId already bound",
    });
    const res = await register(envWith(validator));
    expect(res.status).toBe(409);
  });

  it("rejected -> 403 (invalid signature chain)", async () => {
    const { validator } = mockValidator({
      kind: "rejected",
      status: 422,
      detail: "bad chain",
    });
    const res = await register(envWith(validator));
    expect(res.status).toBe(403);
  });

  it("unavailable -> 503 (univocity transient/unreachable)", async () => {
    const { validator } = mockValidator({
      kind: "unavailable",
      detail: "unreachable",
    });
    const res = await register(envWith(validator));
    expect(res.status).toBe(503);
  });

  it("no validator configured -> 503 (no local fallback)", async () => {
    const res = await register(envWith(undefined));
    expect(res.status).toBe(503);
  });

  it("wrong grant shape (not create+extend) -> 403 without calling validator", async () => {
    const { validator, calls } = mockValidator({
      kind: "accepted",
      created: true,
    });
    const noCreate = new Uint8Array(8);
    noCreate[7] = 0x01;
    const res = await register(envWith(validator), creationGrant(noCreate));
    expect(res.status).toBe(403);
    expect(calls).toHaveLength(0);
  });
});
