import { randomUUID } from "node:crypto";
import { encodeCborDeterministic } from "@forestrie/encoding";
import { fetchMock } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import { bytesToBase64 } from "../../src/encoding.js";
import {
  hex32ToWireLogIdBytes,
  normalizeLogIdToHex32,
} from "../../src/log-id.js";
import {
  COORDINATOR_HINT_SOURCE,
  buildSealHint,
  hex32ToUuid,
  parseMassifHeights,
  publishCertificateSealHints,
} from "../../src/seal-hint.js";
import {
  buildTestByokMaterial,
  generateTestRootKeyPair,
  testDelegatedCoseKey,
} from "./byok-material-fixture.js";
import { fetchWithDoRetry } from "./fetch-with-do-retry.js";

const TEST_TOKEN = "test-coordinator-token";
// Must match the top-level wrangler.jsonc test vars.
const QUEUE_ORIGIN = "https://queues.example.test";
const QUEUE_PATH = "/accounts/test/queues/seal-triggers/messages";

function authHeaders(extra?: HeadersInit): HeadersInit {
  return { Authorization: `Bearer ${TEST_TOKEN}`, ...extra };
}

async function postIssue(opts: {
  logHex32: string;
  mmrStart: number;
  mmrEnd: number;
  delegatedPublicKey: Uint8Array;
}): Promise<Response> {
  return fetchWithDoRetry("http://localhost/api/delegations", {
    method: "POST",
    headers: authHeaders({
      "Content-Type": "application/cbor",
      Accept: "application/cbor",
    }),
    body: encodeCborDeterministic({
      version: 1,
      logId: hex32ToWireLogIdBytes(opts.logHex32),
      mmrStart: opts.mmrStart,
      mmrEnd: opts.mmrEnd,
      algorithm: "ES256",
      delegatedPublicKey: opts.delegatedPublicKey,
      requestedTtlSeconds: 3600,
    }),
  });
}

async function submitCertificate(opts: {
  logUuid: string;
  logHex32: string;
  mmrStart: number;
  mmrEnd: number;
  delegatedPublicKey: Uint8Array;
}): Promise<Response> {
  const rootKeyPair = await generateTestRootKeyPair();
  const { x, y, certificate, issuedAt, expiresAt } =
    await buildTestByokMaterial({
      rootKeyPair,
      logIdHex32: opts.logHex32,
      mmrStart: opts.mmrStart,
      mmrEnd: opts.mmrEnd,
      delegatedPublicKey: opts.delegatedPublicKey,
    });
  const rootRes = await fetchWithDoRetry(
    `http://localhost/api/logs/${opts.logUuid}/public-root`,
    {
      method: "POST",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({
        alg: "ES256",
        x: bytesToBase64(x),
        y: bytesToBase64(y),
      }),
    },
  );
  expect(rootRes.status).toBe(200);
  return fetchWithDoRetry("http://localhost/api/delegations/certificate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      logId: opts.logUuid,
      mmrStart: opts.mmrStart,
      mmrEnd: opts.mmrEnd,
      delegatedPublicKey: bytesToBase64(opts.delegatedPublicKey),
      certificate: bytesToBase64(certificate),
      issuedAt,
      expiresAt,
    }),
  });
}

describe("seal hint building", () => {
  it("formats the massif object key the sealer's consumer parses", () => {
    const hex32 = "1c47d20d540e45968e61f16f47ba332b";
    const hint = buildSealHint(hex32, 14, "2026-08-10T12:00:00.000Z");
    // Expected consumer format: v2/merklelog/massifs/{height}/{logId}/{index}.log
    expect(hint.object.key).toBe(
      "v2/merklelog/massifs/14/1c47d20d-540e-4596-8e61-f16f47ba332b/0000000000000000.log",
    );
    expect(hint.action).toBe("PutObject");
    expect(hint.hintSource).toBe(COORDINATOR_HINT_SOURCE);
  });

  it("round-trips hex32 to a canonical uuid", () => {
    const uuid = randomUUID();
    expect(hex32ToUuid(normalizeLogIdToHex32(uuid))).toBe(uuid);
  });

  it("parses massif heights with a safe default", () => {
    expect(parseMassifHeights(undefined)).toEqual([14]);
    expect(parseMassifHeights("14, 11")).toEqual([14, 11]);
    expect(parseMassifHeights("garbage")).toEqual([14]);
  });

  it("is a no-op without a queue URL", async () => {
    // Would throw on any network call under disableNetConnect if it fetched.
    fetchMock.activate();
    fetchMock.disableNetConnect();
    try {
      await publishCertificateSealHints({}, "00".repeat(16));
    } finally {
      fetchMock.deactivate();
    }
  });
});

describe("POST /api/delegations/certificate wakes parked sealing", () => {
  afterEach(() => {
    fetchMock.assertNoPendingInterceptors();
    fetchMock.deactivate();
  });

  it("publishes a seal hint when the certificate satisfies pending rows", async () => {
    fetchMock.activate();
    fetchMock.disableNetConnect();

    const logUuid = randomUUID();
    const logHex32 = normalizeLogIdToHex32(logUuid);
    const key = testDelegatedCoseKey(31);

    // The sealer asked and was parked (202 + pending row).
    expect(
      (
        await postIssue({
          logHex32,
          mmrStart: 0,
          mmrEnd: 1,
          delegatedPublicKey: key,
        })
      ).status,
    ).toBe(202);

    let hintBody = "";
    fetchMock
      .get(QUEUE_ORIGIN)
      .intercept({ path: QUEUE_PATH, method: "POST" })
      .reply(200, (opts) => {
        hintBody = opts.body as string;
        return "{}";
      });

    // The late certificate (wallet-signed BYOK ordering) covers the demand.
    const res = await submitCertificate({
      logUuid,
      logHex32,
      mmrStart: 0,
      mmrEnd: Number.MAX_SAFE_INTEGER,
      delegatedPublicKey: key,
    });
    expect(res.status).toBe(200);

    // waitUntil publication settles off the response path.
    await new Promise((resolve) => setTimeout(resolve, 100));

    const push = JSON.parse(hintBody) as { body: string; content_type: string };
    expect(push.content_type).toBe("text");
    const hint = JSON.parse(push.body) as {
      action: string;
      object: { key: string };
      hintSource: string;
    };
    expect(hint.action).toBe("PutObject");
    expect(hint.hintSource).toBe(COORDINATOR_HINT_SOURCE);
    expect(hint.object.key).toContain(`/${logUuid}/`);
  });

  it("does not publish when no pending row was satisfied", async () => {
    fetchMock.activate();
    fetchMock.disableNetConnect();
    // No interceptor registered: any queue call would fail the net-connect
    // guard AND assertNoPendingInterceptors in afterEach.

    const logUuid = randomUUID();
    const logHex32 = normalizeLogIdToHex32(logUuid);
    const res = await submitCertificate({
      logUuid,
      logHex32,
      mmrStart: 0,
      mmrEnd: 100,
      delegatedPublicKey: testDelegatedCoseKey(57),
    });
    expect(res.status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 100));
  });
});
