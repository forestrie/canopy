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

import { env as poolEnv } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { encodeCborDeterministic } from "@forestrie/encoding";
import type { SettlementJob } from "@canopy/x402-settlement-types";
import type { LogAuthority } from "../src/env/log-authority.js";
import type { LogAuthorityReader } from "../src/env/log-authority-reader.js";
import {
  ANCHORED_AUTHORITY,
  readerAnswering,
} from "./helpers/log-authority-stub.js";
import type { Grant } from "../src/grant/types.js";
import { uuidToBytes } from "../src/grant/uuid-bytes.js";
import { withChildPaymentRequired } from "../src/grant/grant-flags.js";
import {
  registerGrant,
  type RegisterGrantEnv,
} from "../src/scrapi/register-grant.js";
import type {
  CreationGrantValidator,
  UnivocityGrantResult,
} from "../src/scrapi/univocity-grant-client.js";
import { encodeCustodianProfileForestrieGrant } from "./helpers/custodian-transparent-grant.js";
import { decodeCborAsObject } from "./helpers/cbor-decode-object.js";

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
  g[3] = 0x03;
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

const ANCHORED = ANCHORED_AUTHORITY;

const PENDING: LogAuthority = {
  kind: "pending",
  state: "sequenced",
  blockedBy: uuidToBytes(PARENT),
};

function envWith(
  creationGrantValidator?: CreationGrantValidator,
  logAuthority: LogAuthorityReader = readerAnswering(ANCHORED).reader,
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
    logAuthority,
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

  // L4 (review): on a paid lane, an unpaid creation under a payment-required
  // parent must be gated BEFORE univocity validate() — validate() atomically
  // consumes the logId→R uniqueness claim, so gating after it would let an
  // unpaid caller squat a namespace. Assert the 402 comes back with the
  // validator never invoked. (No receipt resolver is wired here, so L2 is skipped
  // and the request reaches the payment challenge rather than a 403.)
  it("L4: unpaid payment-required creation is 402'd before validate() runs", async () => {
    const { validator, calls } = mockValidator({
      kind: "accepted",
      created: true,
    });
    const env: RegisterGrantEnv = {
      ...envWith(validator),
      payment: {
        REGISTER_GRANT_ADMISSION: "paid",
        REGISTER_GRANT_PRICE_ATOMIC: "10000",
        X402_NETWORK: "eip155:84532",
        X402_PAYTO_ADDRESS: "0x75be7950F26fe7F15336a10b33A8D8134faDb787",
        R2_GRANTS: {} as R2Bucket,
      },
    };
    // Parent auth grant carrying GF_DERIVED | GF_CHILD_PAYMENT_REQUIRED, whose
    // logId == the child's ownerLogId (PARENT) — a coherent payment-required
    // authority. Carried as register-grant body evidence `{ parentGrant }`.
    const parent: Grant = {
      logId: uuidToBytes(PARENT),
      ownerLogId: uuidToBytes(PARENT),
      grant: withChildPaymentRequired(authFlags()),
      maxHeight: 0,
      minGrowth: 0,
      grantData: subjectGrantData,
    };
    const parentBytes = await encodeCustodianProfileForestrieGrant(
      parent,
      subjectPriv,
      TEST_KID,
      new Uint8Array(8),
    );
    const body = encodeCborDeterministic(
      new Map<string, Uint8Array>([["parentGrant", parentBytes]]),
    );
    // A create+extend child bounded to a positive batch (so the gate reaches the
    // payment challenge rather than the maxHeight<1 → 400 guard), with no X-PAYMENT.
    const child: Grant = { ...creationGrant(), maxHeight: 5 };
    const request = new Request(`http://test/register/${PARENT}/grants`, {
      method: "POST",
      headers: { Authorization: await forestrieAuth(child, subjectPriv) },
      body,
    });
    const res = await registerGrant(request, env);
    expect(res.status).toBe(402);
    expect(calls).toHaveLength(0); // validate() never ran → no namespace squat
  });
});

describe("registerGrant admission: the owner log must be anchored", () => {
  it("refuses a create grant under a pending owner with 409 authority-pending, before univocity is called", async () => {
    const { validator, calls } = mockValidator({
      kind: "accepted",
      created: true,
    });
    const { reader, asked } = readerAnswering(PENDING);
    const res = await register(envWith(validator, reader));

    expect(res.status).toBe(409);
    const body = decodeCborAsObject(
      new Uint8Array(await res.arrayBuffer()),
    ) as Record<string, unknown>;
    expect(body.type).toBe("authority-pending");
    expect(body.blockedBy).toBe(PARENT);
    expect(res.headers.get("Retry-After")).not.toBeNull();
    expect(calls).toHaveLength(0);
    // The owner (the log the grant is sequenced into) is what was checked.
    expect(asked).toEqual([PARENT.replace(/-/g, "")]);
  });

  it("refuses a create grant to a conflicted owner with 409 authority-conflict", async () => {
    const { validator, calls } = mockValidator({
      kind: "accepted",
      created: true,
    });
    const { reader } = readerAnswering({ kind: "conflicted" });
    const res = await register(envWith(validator, reader));

    expect(res.status).toBe(409);
    const body = decodeCborAsObject(
      new Uint8Array(await res.arrayBuffer()),
    ) as Record<string, unknown>;
    expect(body.type).toBe("authority-conflict");
    expect(res.headers.get("Retry-After")).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it("returns 503 when the owner's authority is unavailable", async () => {
    const { validator, calls } = mockValidator({
      kind: "accepted",
      created: true,
    });
    const { reader } = readerAnswering({
      kind: "unavailable",
      detail: "univocity down",
    });
    const res = await register(envWith(validator, reader));

    expect(res.status).toBe(503);
    expect(calls).toHaveLength(0);
  });

  it("refuses a paid child grant under a pending owner before settlement; its retry after anchoring settles once", async () => {
    const { validator, calls } = mockValidator({
      kind: "accepted",
      created: true,
    });
    const { reader } = readerAnswering(PENDING, ANCHORED);
    const sent: SettlementJob[] = [];
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ isValid: true }), { status: 200 }),
    );
    const env: RegisterGrantEnv = {
      ...envWith(validator, reader),
      payment: {
        REGISTER_GRANT_ADMISSION: "paid",
        REGISTER_GRANT_PRICE_ATOMIC: "10000",
        X402_NETWORK: "eip155:84532",
        X402_PAYTO_ADDRESS: PAY_TO,
        X402_FACILITATOR_URL: "https://facilitator.invalid",
        X402_SETTLEMENT_QUEUE: {
          send: async (job: SettlementJob) => {
            sent.push(job);
          },
        } as unknown as Queue<SettlementJob>,
        R2_GRANTS: (poolEnv as unknown as { R2_GRANTS: R2Bucket }).R2_GRANTS,
      },
    };
    const child: Grant = { ...creationGrant(), maxHeight: 5 };
    const nonce = `0x${crypto.randomUUID().replace(/-/g, "").padEnd(64, "0")}`;
    const paidRequest = async () =>
      new Request(`http://test/register/${PARENT}/grants`, {
        method: "POST",
        headers: {
          Authorization: await forestrieAuth(child, subjectPriv),
          "X-PAYMENT": paymentHeader("50000", nonce),
        },
        body: await parentGrantBody(),
      });

    const refused = await registerGrant(await paidRequest(), env);
    expect(refused.status).toBe(409);
    expect(sent).toHaveLength(0);
    expect(calls).toHaveLength(0);

    const accepted = await registerGrant(await paidRequest(), env);
    expect(accepted.status).toBe(303);
    expect(sent).toHaveLength(1);
    expect(calls).toHaveLength(1);
  });
});

const PAY_TO = "0x75be7950F26fe7F15336a10b33A8D8134faDb787";

/** x402 exact-scheme payment for the register URL (as register-grant-payment.test.ts). */
function paymentHeader(amount: string, nonce: string): string {
  return btoa(
    JSON.stringify({
      x402Version: 2,
      payload: {
        signature: "0xsig",
        authorization: {
          from: "0x0c552c20eee6644112b4965ff70f929c4ab80d4b",
          to: PAY_TO,
          value: amount,
          validAfter: "0",
          validBefore: "9999999999",
          nonce,
        },
      },
      resource: {
        url: `http://test/register/${PARENT}/grants`,
        mimeType: "application/cbor",
      },
      accepted: {
        scheme: "exact",
        network: "eip155:84532",
        amount,
        asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
        payTo: PAY_TO,
      },
    }),
  );
}

/** Register-grant body evidence: a payment-required parent auth grant over PARENT. */
async function parentGrantBody(): Promise<Uint8Array> {
  const parent: Grant = {
    logId: uuidToBytes(PARENT),
    ownerLogId: uuidToBytes(PARENT),
    grant: withChildPaymentRequired(authFlags()),
    maxHeight: 0,
    minGrowth: 0,
    grantData: subjectGrantData,
  };
  const parentBytes = await encodeCustodianProfileForestrieGrant(
    parent,
    subjectPriv,
    TEST_KID,
    new Uint8Array(8),
  );
  return encodeCborDeterministic(
    new Map<string, Uint8Array>([["parentGrant", parentBytes]]),
  ) as Uint8Array;
}
