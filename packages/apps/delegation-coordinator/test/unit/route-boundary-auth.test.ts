import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { bytesToBase64 } from "../../src/encoding.js";
import { normalizeLogIdToHex32 } from "../../src/log-id.js";
import {
  buildTestByokMaterial,
  generateTestRootKeyPair,
  testDelegatedCoseKey,
} from "./byok-material-fixture.js";
import { fetchWithDoRetry } from "./fetch-with-do-retry.js";
import {
  expectEnabledBody,
  mintTestSessionToken,
  sessionHeaders,
} from "./wallet-session-helpers.js";

const TEST_TOKEN = "test-coordinator-token";

function appTokenHeaders(extra?: HeadersInit): HeadersInit {
  return {
    Authorization: `Bearer ${TEST_TOKEN}`,
    ...extra,
  };
}

describe("route-boundary auth (ENABLE_WALLET_CHALLENGE=true)", () => {
  const logUuid = randomUUID();
  const logHex32 = normalizeLogIdToHex32(logUuid);
  const otherUuid = randomUUID();
  const otherHex32 = normalizeLogIdToHex32(otherUuid);
  const enabledLogUuid = randomUUID();
  const enabledLogHex32 = normalizeLogIdToHex32(enabledLogUuid);

  it("rejects app token on GET /api/delegations/pending", async () => {
    const res = await fetchWithDoRetry(
      `http://localhost/api/delegations/pending?authLogId=${logUuid}`,
      { method: "GET", headers: appTokenHeaders() },
    );
    expect(res.status).toBe(401);
  });

  it("accepts session on GET /api/delegations/pending", async () => {
    const token = mintTestSessionToken({
      authLogIdHex32: logHex32,
      scopes: ["delegations:read"],
    });
    const res = await fetchWithDoRetry(
      `http://localhost/api/delegations/pending?authLogId=${logUuid}`,
      { method: "GET", headers: sessionHeaders(token) },
    );
    expect(res.status).toBe(200);
  });

  it("returns 403 when session authLogId does not match query", async () => {
    const token = mintTestSessionToken({
      authLogIdHex32: otherHex32,
      scopes: ["delegations:read"],
    });
    const res = await fetchWithDoRetry(
      `http://localhost/api/delegations/pending?authLogId=${logUuid}`,
      { method: "GET", headers: sessionHeaders(token) },
    );
    expect(res.status).toBe(403);
  });

  it("returns 403 when session authLogId does not match path logId on enabled", async () => {
    const token = mintTestSessionToken({
      authLogIdHex32: otherHex32,
      scopes: ["logs:enabled:read"],
    });
    const res = await fetchWithDoRetry(
      `http://localhost/api/logs/${logUuid}/enabled`,
      { method: "GET", headers: sessionHeaders(token) },
    );
    expect(res.status).toBe(403);
  });

  it("rejects wallet session on GET /admin/api/logs/{id}/enabled", async () => {
    const token = mintTestSessionToken({
      authLogIdHex32: logHex32,
      scopes: ["logs:enabled:read"],
    });
    const res = await fetchWithDoRetry(
      `http://localhost/admin/api/logs/${logUuid}/enabled`,
      { method: "GET", headers: sessionHeaders(token) },
    );
    expect(res.status).toBe(401);
  });

  it("accepts operator token on GET /admin/api/logs/{id}/enabled", async () => {
    const seed = await fetchWithDoRetry(
      `http://localhost/admin/api/logs/${enabledLogUuid}/enabled`,
      {
        method: "PUT",
        headers: appTokenHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({ enabled: true }),
      },
    );
    expect(seed.status).toBe(200);

    const res = await fetchWithDoRetry(
      `http://localhost/admin/api/logs/${enabledLogUuid}/enabled`,
      { method: "GET", headers: appTokenHeaders() },
    );
    expect(res.status).toBe(200);
    expectEnabledBody(await res.json(), true);
  });

  it("accepts session on GET /api/logs/{id}/enabled", async () => {
    const seed = await fetchWithDoRetry(
      `http://localhost/admin/api/logs/${enabledLogUuid}/enabled`,
      {
        method: "PUT",
        headers: appTokenHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({ enabled: true }),
      },
    );
    expect(seed.status).toBe(200);

    const token = mintTestSessionToken({
      authLogIdHex32: enabledLogHex32,
      scopes: ["logs:enabled:read"],
    });
    const res = await fetchWithDoRetry(
      `http://localhost/api/logs/${enabledLogUuid}/enabled`,
      { method: "GET", headers: sessionHeaders(token) },
    );
    expect(res.status).toBe(200);
    expectEnabledBody(await res.json(), true);
  });
});

describe("public reads (no credential)", () => {
  const logUuid = "a1234567-89ab-cdef-0123-456789abcdef";

  it("GET public-root succeeds without Authorization", async () => {
    const res = await fetchWithDoRetry(
      `http://localhost/api/logs/${logUuid}/public-root`,
      {
        method: "GET",
        headers: { Accept: "application/cbor" },
      },
    );
    expect([200, 404]).toContain(res.status);
  });

  it("GET pending-delegation succeeds without Authorization", async () => {
    const res = await fetchWithDoRetry(
      `http://localhost/api/logs/${logUuid}/pending-delegation`,
      { method: "GET" },
    );
    expect(res.status).toBe(200);
  });
});

describe("POST /api/delegations/certificate (public sealing)", () => {
  const logUuid = randomUUID();
  const logHex32 = normalizeLogIdToHex32(logUuid);
  const delegatedKey = testDelegatedCoseKey(42);
  const mmrStart = 1;
  const mmrEnd = 8;

  it("returns 404 when public root is not registered", async () => {
    const rootKeyPair = await generateTestRootKeyPair();
    const { certificate, issuedAt, expiresAt } = await buildTestByokMaterial({
      rootKeyPair,
      logIdHex32: logHex32,
      mmrStart,
      mmrEnd,
      delegatedPublicKey: delegatedKey,
    });

    const res = await fetchWithDoRetry(
      "http://localhost/api/delegations/certificate",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          logId: logUuid,
          mmrStart,
          mmrEnd,
          delegatedPublicKey: bytesToBase64(delegatedKey),
          certificate: bytesToBase64(certificate),
          issuedAt,
          expiresAt,
        }),
      },
    );
    expect(res.status).toBe(404);
  });

  it("returns 400 on invalid signature after root registration", async () => {
    const rootKeyPair = await generateTestRootKeyPair();
    const good = await buildTestByokMaterial({
      rootKeyPair,
      logIdHex32: logHex32,
      mmrStart,
      mmrEnd,
      delegatedPublicKey: delegatedKey,
    });

    const rootRes = await fetchWithDoRetry(
      `http://localhost/api/logs/${logUuid}/public-root`,
      {
        method: "POST",
        headers: appTokenHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({
          alg: "ES256",
          x: bytesToBase64(good.x),
          y: bytesToBase64(good.y),
        }),
      },
    );
    expect(rootRes.status).toBe(200);

    const badCert = new Uint8Array(good.certificate);
    badCert[badCert.length - 1]! ^= 0xff;

    const res = await fetchWithDoRetry(
      "http://localhost/api/delegations/certificate",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          logId: logUuid,
          mmrStart,
          mmrEnd,
          delegatedPublicKey: bytesToBase64(delegatedKey),
          certificate: bytesToBase64(badCert),
          issuedAt: good.issuedAt,
          expiresAt: good.expiresAt,
        }),
      },
    );
    expect(res.status).toBe(400);
  });

  it("accepts valid certificate without credential and replays idempotently", async () => {
    const logUuid2 = randomUUID();
    const logHex32_2 = normalizeLogIdToHex32(logUuid2);
    const rootKeyPair = await generateTestRootKeyPair();
    const { x, y, certificate, issuedAt, expiresAt } =
      await buildTestByokMaterial({
        rootKeyPair,
        logIdHex32: logHex32_2,
        mmrStart,
        mmrEnd,
        delegatedPublicKey: delegatedKey,
      });

    const rootRes = await fetchWithDoRetry(
      `http://localhost/api/logs/${logUuid2}/public-root`,
      {
        method: "POST",
        headers: appTokenHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({
          alg: "ES256",
          x: bytesToBase64(x),
          y: bytesToBase64(y),
        }),
      },
    );
    expect(rootRes.status).toBe(200);

    const payload = {
      logId: logUuid2,
      mmrStart,
      mmrEnd,
      delegatedPublicKey: bytesToBase64(delegatedKey),
      certificate: bytesToBase64(certificate),
      issuedAt,
      expiresAt,
    };

    const first = await fetchWithDoRetry(
      "http://localhost/api/delegations/certificate",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      },
    );
    expect(first.status).toBe(200);

    const second = await fetchWithDoRetry(
      "http://localhost/api/delegations/certificate",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      },
    );
    expect(second.status).toBe(200);
  });

  it("returns 413 when decoded certificate exceeds size cap", async () => {
    const oversized = bytesToBase64(new Uint8Array(17 * 1024));
    const res = await fetchWithDoRetry(
      "http://localhost/api/delegations/certificate",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          logId: logUuid,
          mmrStart: 0,
          mmrEnd: 1,
          delegatedPublicKey: bytesToBase64(delegatedKey),
          certificate: oversized,
          issuedAt: 1,
          expiresAt: 2,
        }),
      },
    );
    expect(res.status).toBe(413);
  });
});
