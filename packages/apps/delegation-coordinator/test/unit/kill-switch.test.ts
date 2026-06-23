import { encode } from "cbor-x";
import { describe, expect, it } from "vitest";
import { bytesToBase64 } from "../../src/encoding.js";
import {
  hex32ToWireLogIdBytes,
  normalizeLogIdToHex32,
} from "../../src/log-id.js";
import type { PendingEntry } from "../../src/types/pending-entry.js";
import {
  buildTestByokMaterial,
  generateTestRootKeyPair,
  testDelegatedCoseKey,
} from "./byok-material-fixture.js";
import { fetchWithDoRetry } from "./fetch-with-do-retry.js";

const TEST_TOKEN = "test-coordinator-token";

function authHeaders(extra?: HeadersInit): HeadersInit {
  return {
    Authorization: `Bearer ${TEST_TOKEN}`,
    ...extra,
  };
}

function cborBody(value: unknown): Uint8Array {
  const encoded = encode(value);
  return encoded instanceof Uint8Array
    ? encoded
    : new Uint8Array(encoded as ArrayLike<number>);
}

async function putEnabled(
  logUuid: string,
  enabled: boolean,
): Promise<Response> {
  return fetchWithDoRetry(
    `http://localhost/admin/api/logs/${logUuid}/enabled`,
    {
      method: "PUT",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ enabled }),
    },
  );
}

async function postIssue(opts: {
  logHex32: string;
  mmrStart: number;
  mmrEnd: number;
  delegatedPublicKey: Uint8Array;
}): Promise<Response> {
  const body = cborBody({
    version: 1,
    logId: hex32ToWireLogIdBytes(opts.logHex32),
    mmrStart: opts.mmrStart,
    mmrEnd: opts.mmrEnd,
    algorithm: "ES256",
    delegatedPublicKey: opts.delegatedPublicKey,
    requestedTtlSeconds: 3600,
  });
  return fetchWithDoRetry("http://localhost/api/delegations", {
    method: "POST",
    headers: authHeaders({
      "Content-Type": "application/cbor",
      Accept: "application/cbor",
    }),
    body,
  });
}

async function seedCertificate(
  logUuid: string,
  logHex32: string,
  delegatedKey: Uint8Array,
): Promise<void> {
  const rootKeyPair = await generateTestRootKeyPair();
  const { x, y, certificate, issuedAt, expiresAt } =
    await buildTestByokMaterial({
      rootKeyPair,
      logIdHex32: logHex32,
      mmrStart: 4,
      mmrEnd: 11,
      delegatedPublicKey: delegatedKey,
    });

  const rootRes = await fetchWithDoRetry(
    `http://localhost/api/logs/${logUuid}/public-root`,
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

  const certificateRes = await fetchWithDoRetry(
    "http://localhost/api/delegations/certificate",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        logId: logUuid,
        mmrStart: 4,
        mmrEnd: 11,
        delegatedPublicKey: bytesToBase64(delegatedKey),
        certificate: bytesToBase64(certificate),
        issuedAt,
        expiresAt,
      }),
    },
  );
  expect(certificateRes.status).toBe(200);

  const hit = await postIssue({
    logHex32,
    mmrStart: 4,
    mmrEnd: 11,
    delegatedPublicKey: delegatedKey,
  });
  expect(hit.status).toBe(200);
}

describe("kill switch (enabled flag)", () => {
  it("disabled issue returns 202 even when material exists", async () => {
    const logUuid = "81234567-89ab-cdef-0123-456789abcdef";
    const logHex32 = normalizeLogIdToHex32(logUuid);
    const delegatedKey = testDelegatedCoseKey(92);

    await seedCertificate(logUuid, logHex32, delegatedKey);

    const disableRes = await putEnabled(logUuid, false);
    expect(disableRes.status).toBe(200);

    const miss = await postIssue({
      logHex32,
      mmrStart: 4,
      mmrEnd: 11,
      delegatedPublicKey: delegatedKey,
    });
    expect(miss.status).toBe(202);

    const enableRes = await putEnabled(logUuid, true);
    expect(enableRes.status).toBe(200);

    const hit = await postIssue({
      logHex32,
      mmrStart: 4,
      mmrEnd: 11,
      delegatedPublicKey: delegatedKey,
    });
    expect(hit.status).toBe(200);
  });

  it("disabled pending-delegation returns empty then restores on re-enable", async () => {
    const logUuid = "91234567-89ab-cdef-0123-456789abcdef";
    const logHex32 = normalizeLogIdToHex32(logUuid);
    const delegatedKey = testDelegatedCoseKey(93);

    const miss = await postIssue({
      logHex32,
      mmrStart: 5,
      mmrEnd: 12,
      delegatedPublicKey: delegatedKey,
    });
    expect(miss.status).toBe(202);

    const pendingBefore = await fetchWithDoRetry(
      `http://localhost/api/logs/${logUuid}/pending-delegation`,
      { method: "GET" },
    );
    expect(pendingBefore.status).toBe(200);
    const beforeBody = (await pendingBefore.json()) as {
      entries: PendingEntry[];
    };
    expect(beforeBody.entries.length).toBeGreaterThan(0);

    const disableRes = await putEnabled(logUuid, false);
    expect(disableRes.status).toBe(200);

    const pendingDisabled = await fetchWithDoRetry(
      `http://localhost/api/logs/${logUuid}/pending-delegation`,
      { method: "GET" },
    );
    expect(pendingDisabled.status).toBe(200);
    const disabledBody = (await pendingDisabled.json()) as {
      entries: PendingEntry[];
    };
    expect(disabledBody.entries).toEqual([]);

    const enableRes = await putEnabled(logUuid, true);
    expect(enableRes.status).toBe(200);

    const pendingAfter = await fetchWithDoRetry(
      `http://localhost/api/logs/${logUuid}/pending-delegation`,
      { method: "GET" },
    );
    expect(pendingAfter.status).toBe(200);
    const afterBody = (await pendingAfter.json()) as {
      entries: PendingEntry[];
    };
    expect(afterBody.entries.length).toBeGreaterThan(0);
  });
});
