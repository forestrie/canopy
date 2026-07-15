/**
 * Active-delegation set endpoint (GET /api/delegations/active) — backs the
 * sealer's level-triggered resync (arbor plan-2607-04 / ADR-0007 phase-3 sweep).
 *
 * Verifies: the endpoint requires the app token; a malformed cursor is a 400; a
 * paged walk across all 4 DO shards (opaque cursor, small page size) returns
 * every active log exactly once; a soon-to-expire cert is included; and
 * graceSeconds is clamped and echoed.
 *
 * NOTE: the *exclusion* of a long-expired cert is not integration-tested here —
 * the DO refuses to store any cert with `expiresAt <= now + 60`
 * (delegation-store `handlePutCertificate`), so an expired row can only arise
 * from the passage of real time, which this Worker-realm test cannot fake. The
 * threshold (`expires_at > now - grace`) is plain arithmetic exercised by the
 * inclusion cases.
 */

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

const TEST_TOKEN = "test-coordinator-token";

function authHeaders(extra?: HeadersInit): HeadersInit {
  return { Authorization: `Bearer ${TEST_TOKEN}`, ...extra };
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

async function registerEs256Root(
  logUuid: string,
  x: Uint8Array,
  y: Uint8Array,
): Promise<void> {
  const res = await fetchWithDoRetry(
    `http://localhost/api/logs/${logUuid}/public-root`,
    {
      method: "POST",
      headers: { ...authHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({
        alg: "ES256",
        x: bytesToBase64(x),
        y: bytesToBase64(y),
      }),
    },
  );
  expect(res.status).toBe(200);
}

/** Seed one ES256 advance cert for a fresh log with a chosen expiry. */
async function seedCert(opts: {
  seed: number;
  expiresAt: number;
  mmrEnd?: number;
}): Promise<string> {
  const logUuid = randomUUID();
  const logHex32 = normalizeLogIdToHex32(logUuid);
  const rootKeyPair = await generateTestRootKeyPair();
  const delegatedPublicKey = testDelegatedCoseKey(opts.seed);
  const mmrEnd = opts.mmrEnd ?? 16383;
  const material = await buildTestByokMaterial({
    rootKeyPair,
    logIdHex32: logHex32,
    mmrStart: 0,
    mmrEnd,
    delegatedPublicKey,
    issuedAt: 1_700_000_000,
    expiresAt: opts.expiresAt,
  });
  await registerEs256Root(logUuid, material.x, material.y);

  const putRes = await fetchWithDoRetry(
    "http://localhost/api/delegations/certificate",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        logId: logHex32,
        mmrStart: 0,
        mmrEnd,
        delegatedPublicKey: bytesToBase64(delegatedPublicKey),
        certificate: bytesToBase64(material.certificate),
        issuedAt: material.issuedAt,
        expiresAt: material.expiresAt,
      }),
    },
  );
  expect(putRes.status).toBe(200);
  return logHex32;
}

interface ActiveLog {
  logIdHex32: string;
  expiresAt: number;
  mmrEnd: number | null;
}

/** Page the whole active set following the opaque cursor to termination. */
async function walkActive(opts: {
  graceSeconds: number;
  limit: number;
}): Promise<ActiveLog[]> {
  const collected: ActiveLog[] = [];
  let cursor: string | null = null;
  // A shard walk terminates in ≤ (shardCount + total rows) pages; cap well
  // above that so a cursor bug fails the test instead of hanging it.
  for (let i = 0; i < 1000; i++) {
    const url = new URL("http://localhost/api/delegations/active");
    url.searchParams.set("graceSeconds", String(opts.graceSeconds));
    url.searchParams.set("limit", String(opts.limit));
    if (cursor) url.searchParams.set("cursor", cursor);

    const res = await fetchWithDoRetry(url.toString(), {
      method: "GET",
      headers: authHeaders(),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      logs: ActiveLog[];
      cursor: string | null;
    };
    collected.push(...body.logs);
    cursor = body.cursor;
    if (cursor === null) return collected;
  }
  throw new Error("walkActive did not terminate — opaque cursor never nulled");
}

/** Count occurrences of a logId within a walk result. */
function countOf(logs: ActiveLog[], logHex32: string): number {
  return logs.filter((l) => l.logIdHex32 === logHex32).length;
}

describe("GET /api/delegations/active", () => {
  it("requires the app token", async () => {
    const res = await fetchWithDoRetry(
      "http://localhost/api/delegations/active",
      { method: "GET" },
    );
    expect(res.status).toBe(401);
  });

  it("rejects a malformed cursor with 400", async () => {
    const res = await fetchWithDoRetry(
      "http://localhost/api/delegations/active?cursor=not-a-cursor",
      { method: "GET", headers: authHeaders() },
    );
    expect(res.status).toBe(400);
  });

  it("returns every active log exactly once across a paged multi-shard walk", async () => {
    const future = 4_102_444_800; // 2100-01-01
    const seeded: string[] = [];
    for (let i = 0; i < 7; i++) {
      seeded.push(await seedCert({ seed: 200 + i, expiresAt: future }));
    }

    // limit=2 with 7 logs spread over 4 shards forces both within-shard and
    // shard-boundary cursor advances.
    const walk = await walkActive({ graceSeconds: 3600, limit: 2 });

    for (const logHex32 of seeded) {
      expect(countOf(walk, logHex32)).toBe(1);
    }
  });

  it("includes a soon-to-expire cert and returns its coverage fields", async () => {
    const soon = nowSeconds() + 120; // passes the now+60 store gate, expires soon
    const logHex32 = await seedCert({ seed: 300, expiresAt: soon, mmrEnd: 42 });

    const walk = await walkActive({ graceSeconds: 0, limit: 100 });
    const row = walk.find((l) => l.logIdHex32 === logHex32);
    expect(row).toBeDefined();
    expect(row!.expiresAt).toBe(soon);
    expect(row!.mmrEnd).toBe(42);
  });

  it("clamps and echoes graceSeconds", async () => {
    const res = await fetchWithDoRetry(
      "http://localhost/api/delegations/active?graceSeconds=999999999",
      { method: "GET", headers: authHeaders() },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { graceSeconds: number };
    expect(body.graceSeconds).toBe(24 * 60 * 60); // MAX_GRACE_SECONDS
  });
});
