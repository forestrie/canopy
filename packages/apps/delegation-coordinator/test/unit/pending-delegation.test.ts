import { encode } from "cbor-x";
import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { bytesToBase64 } from "../../src/encoding.js";
import {
  hex32ToWireLogIdBytes,
  normalizeLogIdToHex32,
} from "../../src/log-id.js";
import type { PendingEntry } from "../../src/types/pending-entry.js";

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
    const logUuid = "31234567-89ab-cdef-0123-456789abcdef";
    const logHex32 = normalizeLogIdToHex32(logUuid);
    const firstKey = delegatedKey(1);
    const secondKey = delegatedKey(101);

    const firstMiss = await postIssue({
      logHex32,
      mmrStart: 0,
      mmrEnd: 7,
      delegatedPublicKey: firstKey,
    });
    expect(firstMiss.status).toBe(503);

    const duplicateMiss = await postIssue({
      logHex32,
      mmrStart: 0,
      mmrEnd: 7,
      delegatedPublicKey: firstKey,
    });
    expect(duplicateMiss.status).toBe(503);

    const secondMiss = await postIssue({
      logHex32,
      mmrStart: 0,
      mmrEnd: 7,
      delegatedPublicKey: secondKey,
    });
    expect(secondMiss.status).toBe(503);

    const pendingRes = await SELF.fetch(
      `http://localhost/api/logs/${logUuid}/pending-delegation`,
      {
        method: "GET",
        headers: authHeaders(),
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
    const logUuid = "41234567-89ab-cdef-0123-456789abcdef";
    const logHex32 = normalizeLogIdToHex32(logUuid);
    const firstKey = delegatedKey(11);
    const secondKey = delegatedKey(121);

    expect(
      (
        await postIssue({
          logHex32,
          mmrStart: 2,
          mmrEnd: 9,
          delegatedPublicKey: firstKey,
        })
      ).status,
    ).toBe(503);
    expect(
      (
        await postIssue({
          logHex32,
          mmrStart: 2,
          mmrEnd: 9,
          delegatedPublicKey: secondKey,
        })
      ).status,
    ).toBe(503);

    const materialRes = await SELF.fetch(
      "http://localhost/api/delegations/material",
      {
        method: "POST",
        headers: authHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({
          logId: logUuid,
          mmrStart: 2,
          mmrEnd: 9,
          delegatedPublicKey: bytesToBase64(firstKey),
          certificate: bytesToBase64(new Uint8Array([1, 2, 3])),
          issuedAt: 1,
          expiresAt: 999999,
        }),
      },
    );
    expect(materialRes.status).toBe(200);

    const pendingRes = await SELF.fetch(
      `http://localhost/api/logs/${logUuid}/pending-delegation`,
      {
        method: "GET",
        headers: authHeaders(),
      },
    );
    const body = (await pendingRes.json()) as { entries: PendingEntry[] };
    const keys = body.entries
      .filter((entry) => entry.logIdHex32 === logHex32)
      .map((entry) => entry.delegatedPublicKey);
    expect(keys).toEqual([bytesToBase64(secondKey)]);
  });
});
