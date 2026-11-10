/**
 * Statement admission refuses a log whose authority is not anchored
 * (protocol ADR-0070, devdocs ADR-0075 decisions 5 and 8). Drives the real
 * worker (`worker.fetch`) in pool-test mode with univocity's
 * `GET /api/logs/{logId}/authority` stubbed. Without a sequencing queue an
 * admitted statement ends at the post-verification 503 naming
 * SEQUENCING_QUEUE, as in register-statement-endorsed.test.ts.
 */

import { env } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { encodeCborDeterministic } from "@forestrie/encoding";
import worker from "../src/index";
import type { Env } from "../src/index";
import type { Grant } from "../src/grant";
import { uuidToBytes } from "../src/grant";
import { custodianStatementKidFromXyGrantData } from "../src/grant/custodian-statement-kid.js";
import { decodeCborAsObject } from "./helpers/cbor-decode-object.js";
import { forestrieGrantAuthorizationHeader } from "./helpers/custodian-transparent-grant";
import {
  exportXy,
  generateP256,
  signStatement,
} from "./helpers/endorsed-statement.js";
import {
  seedGenesisChainIdentity,
  validGenesisV2Es256CborMap,
} from "./helpers/genesis-v2-body.js";
import { mintTestOnboardToken } from "./helpers/onboard-token.js";

const UNIVOCITY = "https://univocity.test";
const OWNER_LOG_ID = "660e8400-e29b-41d4-a716-446655440001";

const testEnv = env as unknown as Env;
/** Worker env with univocity configured; anchored answers are not cached. */
const univocityEnv = {
  ...testEnv,
  UNIVOCITY_SERVICE_URL: UNIVOCITY,
  UNIVOCITY_AUTHORITY_CACHE_SECONDS: "0",
} as Env;

let bootstrapLogId = "";
let root: CryptoKeyPair;
let rootXy: Uint8Array;
let idtimestampSeq = 1;

beforeAll(async () => {
  root = await generateP256();
  rootXy = await exportXy(root.publicKey);
  bootstrapLogId = crypto.randomUUID();
  const { token } = await mintTestOnboardToken(testEnv, "statement-admission");
  const genesis = validGenesisV2Es256CborMap({ bootstrapKey: rootXy });
  await seedGenesisChainIdentity(testEnv, genesis);
  const res = await worker.fetch(
    new Request(`http://localhost/api/forest/${bootstrapLogId}/genesis`, {
      method: "POST",
      headers: {
        "Content-Type": "application/cbor",
        Authorization: `Bearer ${token}`,
      },
      body: encodeCborDeterministic(genesis) as Uint8Array,
    }),
    testEnv,
    {} as ExecutionContext,
  );
  expect(res.status).toBe(201);
});

afterEach(() => {
  vi.restoreAllMocks();
});

/**
 * Stubs univocity's authority read: each read of a log takes the next queued
 * answer (repeating the last); a number is an HTTP status. Other fetches pass
 * through.
 */
function stubAuthority(
  answers: Record<string, Array<Record<string, unknown> | number>>,
) {
  const realFetch = globalThis.fetch;
  return vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async (input, init) => {
      const url = typeof input === "string" ? input : (input as Request).url;
      if (!url.startsWith(UNIVOCITY)) return realFetch(input, init);
      const m = /\/api\/logs\/([^/]+)\/authority$/.exec(new URL(url).pathname);
      const queue = m ? answers[m[1]!] : undefined;
      if (!queue?.length) return new Response("", { status: 404 });
      const next = queue.length > 1 ? queue.shift()! : queue[0]!;
      if (typeof next === "number") return new Response("", { status: next });
      return new Response(
        encodeCborDeterministic(next) as unknown as BodyInit,
        {
          status: 200,
          headers: { "content-type": "application/cbor" },
        },
      );
    });
}

function anchoredAnswer(): Record<string, unknown> {
  return {
    state: "anchored",
    alg: -7,
    key: new Uint8Array(64).fill(3),
    final: false,
  };
}

function dataLogGrant(dataLogId: string): Grant {
  const flags = new Uint8Array(8);
  flags[3] = 0x03; // GF_CREATE | GF_EXTEND
  flags[7] = 0x02; // GF_DATA_LOG
  return {
    logId: uuidToBytes(dataLogId),
    ownerLogId: uuidToBytes(OWNER_LOG_ID),
    grant: flags,
    maxHeight: 0,
    minGrowth: 0,
    grantData: rootXy,
  };
}

async function postStatement(dataLogId: string): Promise<{
  status: number;
  headers: Headers;
  body: Record<string, unknown> | null;
}> {
  const authHeader = await forestrieGrantAuthorizationHeader(
    dataLogGrant(dataLogId),
    root.privateKey,
    custodianStatementKidFromXyGrantData(rootXy),
    new Uint8Array(8).fill(idtimestampSeq++ & 0xff),
  );
  const statement = await signStatement(root, rootXy.slice(0, 32), new Map());
  const response = await worker.fetch(
    new Request(`http://localhost/register/${bootstrapLogId}/entries`, {
      method: "POST",
      headers: {
        "content-type": 'application/cose; cose-type="cose-sign1"',
        Authorization: authHeader,
      },
      body: statement,
    }),
    univocityEnv,
    {} as ExecutionContext,
  );
  const bytes = new Uint8Array(await response.arrayBuffer());
  return {
    status: response.status,
    headers: response.headers,
    body:
      bytes.length > 0
        ? (decodeCborAsObject(bytes) as Record<string, unknown>)
        : null,
  };
}

function expectAdmitted(r: {
  status: number;
  body: Record<string, unknown> | null;
}): void {
  expect(r.status).toBe(503);
  expect(String(r.body?.detail ?? "")).toContain("SEQUENCING_QUEUE");
}

describe("register-signed-statement admission: authority must be anchored", () => {
  it("refuses a statement under a pending log with 409 authority-pending, Retry-After, state and blockedBy; admits it once anchored", async () => {
    const dataLogId = crypto.randomUUID();
    stubAuthority({
      [dataLogId]: [
        {
          state: "sequenced",
          blockedBy: uuidToBytes(OWNER_LOG_ID),
          final: false,
        },
        anchoredAnswer(),
      ],
    });

    const refused = await postStatement(dataLogId);
    expect(refused.status).toBe(409);
    expect(refused.body?.type).toBe("authority-pending");
    expect(refused.body?.state).toBe("sequenced");
    expect(refused.body?.blockedBy).toBe(OWNER_LOG_ID);
    expect(Number(refused.headers.get("Retry-After"))).toBeGreaterThan(0);

    expectAdmitted(await postStatement(dataLogId));
  });

  it("refuses a statement to a conflicted log with 409 authority-conflict and no Retry-After", async () => {
    const dataLogId = crypto.randomUUID();
    stubAuthority({ [dataLogId]: [{ state: "conflicted", final: true }] });

    const refused = await postStatement(dataLogId);
    expect(refused.status).toBe(409);
    expect(refused.body?.type).toBe("authority-conflict");
    expect(refused.body?.state).toBe("conflicted");
    expect(refused.headers.get("Retry-After")).toBeNull();
  });

  it("refuses a statement under a conflicted ancestor as a conflict, naming it", async () => {
    const dataLogId = crypto.randomUUID();
    stubAuthority({
      [dataLogId]: [
        {
          ...anchoredAnswer(),
          final: true,
          blockedBy: uuidToBytes(OWNER_LOG_ID),
        },
      ],
    });

    const refused = await postStatement(dataLogId);
    expect(refused.status).toBe(409);
    expect(refused.body?.type).toBe("authority-conflict");
    expect(refused.body?.blockedBy).toBe(OWNER_LOG_ID);
    expect(refused.headers.get("Retry-After")).toBeNull();
  });

  it("returns 503 when univocity is down and nothing is cached", async () => {
    const dataLogId = crypto.randomUUID();
    stubAuthority({ [dataLogId]: [503] });

    const refused = await postStatement(dataLogId);
    expect(refused.status).toBe(503);
    expect(String(refused.body?.detail ?? "")).toContain("authority");
  });
});
