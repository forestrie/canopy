import { randomUUID } from "node:crypto";
import { encodeCborDeterministic } from "@forestrie/encoding";
import { SELF } from "cloudflare:test";
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

const TEST_TOKEN = "test-coordinator-token";

function authHeaders(extra?: HeadersInit): HeadersInit {
  return {
    Authorization: `Bearer ${TEST_TOKEN}`,
    ...extra,
  };
}

function cborBody(value: unknown): Uint8Array {
  return encodeCborDeterministic(value);
}

function delegatedKey(seed: number): Uint8Array {
  const out = new Uint8Array(24);
  for (let i = 0; i < out.length; i++) out[i] = seed + i;
  return out;
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
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await SELF.fetch("http://localhost/api/delegations", {
      method: "POST",
      headers: authHeaders({
        "Content-Type": "application/cbor",
        Accept: "application/cbor",
      }),
      body,
    });
    if (res.status !== 500) return res;
    const text = await res.clone().text();
    if (!text.includes("invalidating this Durable Object")) return res;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return SELF.fetch("http://localhost/api/delegations", {
    method: "POST",
    headers: authHeaders({
      "Content-Type": "application/cbor",
      Accept: "application/cbor",
    }),
    body,
  });
}

describe("GET /api/logs/{logId}/pending-delegation", () => {
  it("returns full delegated keys and dedupes repeated issue requests", async () => {
    const logUuid = randomUUID();
    const logHex32 = normalizeLogIdToHex32(logUuid);
    const firstKey = delegatedKey(1);
    const secondKey = delegatedKey(101);

    const firstMiss = await postIssue({
      logHex32,
      mmrStart: 0,
      mmrEnd: 7,
      delegatedPublicKey: firstKey,
    });
    expect(firstMiss.status).toBe(202);
    expect(firstMiss.headers.get("Retry-After")).toBe("5");

    const duplicateMiss = await postIssue({
      logHex32,
      mmrStart: 0,
      mmrEnd: 7,
      delegatedPublicKey: firstKey,
    });
    expect(duplicateMiss.status).toBe(202);

    const secondMiss = await postIssue({
      logHex32,
      mmrStart: 0,
      mmrEnd: 7,
      delegatedPublicKey: secondKey,
    });
    expect(secondMiss.status).toBe(202);

    const pendingRes = await SELF.fetch(
      `http://localhost/api/logs/${logUuid}/pending-delegation`,
      {
        method: "GET",
      },
    );
    expect(pendingRes.status).toBe(200);

    const body = (await pendingRes.json()) as { entries: PendingEntry[] };
    const matching = body.entries.filter(
      (entry) =>
        entry.logIdHex32 === logHex32 &&
        entry.mmrStart === 0 &&
        entry.mmrEnd === 7,
    );
    expect(matching).toHaveLength(2);
    expect(matching.map((entry) => entry.delegatedPublicKey).sort()).toEqual(
      [bytesToBase64(firstKey), bytesToBase64(secondKey)].sort(),
    );
  });

  it("material submission clears only the matching key", async () => {
    const logUuid = randomUUID();
    const logHex32 = normalizeLogIdToHex32(logUuid);
    const firstKey = testDelegatedCoseKey(11);
    const secondKey = testDelegatedCoseKey(121);

    expect(
      (
        await postIssue({
          logHex32,
          mmrStart: 2,
          mmrEnd: 9,
          delegatedPublicKey: firstKey,
        })
      ).status,
    ).toBe(202);
    expect(
      (
        await postIssue({
          logHex32,
          mmrStart: 2,
          mmrEnd: 9,
          delegatedPublicKey: secondKey,
        })
      ).status,
    ).toBe(202);

    const rootKeyPair = await generateTestRootKeyPair();
    const { x, y, certificate, issuedAt, expiresAt } =
      await buildTestByokMaterial({
        rootKeyPair,
        logIdHex32: logHex32,
        mmrStart: 2,
        mmrEnd: 9,
        delegatedPublicKey: firstKey,
      });
    const rootRes = await SELF.fetch(
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

    const certificateRes = await SELF.fetch(
      "http://localhost/api/delegations/certificate",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          logId: logUuid,
          mmrStart: 2,
          mmrEnd: 9,
          delegatedPublicKey: bytesToBase64(firstKey),
          certificate: bytesToBase64(certificate),
          issuedAt,
          expiresAt,
        }),
      },
    );
    expect(certificateRes.status).toBe(200);

    const pendingRes = await SELF.fetch(
      `http://localhost/api/logs/${logUuid}/pending-delegation`,
      {
        method: "GET",
      },
    );
    const body = (await pendingRes.json()) as { entries: PendingEntry[] };
    const keys = body.entries
      .filter((entry) => entry.logIdHex32 === logHex32)
      .map((entry) => entry.delegatedPublicKey);
    expect(keys).toEqual([bytesToBase64(secondKey)]);
  });
});
