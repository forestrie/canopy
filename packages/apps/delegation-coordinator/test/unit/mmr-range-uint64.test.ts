/**
 * Delegation MMR range as uint64 end to end through the coordinator
 * (plan-2611-01 slice S3, FOR-613).
 *
 * JSON routes carry each bound as a canonical decimal string (D1); the DO
 * stores it as an 8-byte big-endian BLOB (D2). These tests drive values at
 * 2^32, 2^53+1, 2^63 and 2^64-1 through the real worker routes and the real
 * DO SQLite, where a JSON number or a signed-int64 column would round or
 * overflow.
 */

import { randomUUID } from "node:crypto";
import {
  decodeCborDeterministic,
  encodeCborDeterministic,
} from "@forestrie/encoding";
import { env, runInDurableObject, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { bytesToBase64 } from "../../src/encoding.js";
import {
  hex32ToWireLogIdBytes,
  normalizeLogIdToHex32,
} from "../../src/log-id.js";
import { encodeMmrIndexBe8 } from "../../src/mmr-index-be8.js";
import type { PendingEntry } from "../../src/types/pending-entry.js";
import {
  buildTestByokMaterial,
  generateTestRootKeyPair,
  testDelegatedCoseKey,
} from "./byok-material-fixture.js";
import { fetchWithDoRetry } from "./fetch-with-do-retry.js";

const TEST_TOKEN = "test-coordinator-token";
const FAR_FUTURE = 4_102_444_800; // 2100-01-01

const P32 = 1n << 32n;
const P53_PLUS_1 = (1n << 53n) + 1n;
const P63 = 1n << 63n;
const U64_MAX = (1n << 64n) - 1n;

function authHeaders(extra?: HeadersInit): HeadersInit {
  return { Authorization: `Bearer ${TEST_TOKEN}`, ...extra };
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
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({
        alg: "ES256",
        x: bytesToBase64(x),
        y: bytesToBase64(y),
      }),
    },
  );
  expect(res.status).toBe(200);
}

/** POST /api/delegations/certificate with a raw JSON body. */
function postCertificateJson(body: unknown): Promise<Response> {
  return fetchWithDoRetry("http://localhost/api/delegations/certificate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** A fresh log with a registered ES256 root; certs signed by that root. */
async function freshLog(): Promise<{
  logUuid: string;
  logHex32: string;
  submit: (opts: {
    mmrStart: bigint;
    mmrEnd: bigint;
    keySeed: number;
    expiresAt?: number;
  }) => Promise<Response>;
}> {
  const logUuid = randomUUID();
  const logHex32 = normalizeLogIdToHex32(logUuid);
  const rootKeyPair = await generateTestRootKeyPair();
  let registered = false;
  const submit = async (opts: {
    mmrStart: bigint;
    mmrEnd: bigint;
    keySeed: number;
    expiresAt?: number;
  }): Promise<Response> => {
    const delegatedPublicKey = testDelegatedCoseKey(opts.keySeed);
    const material = await buildTestByokMaterial({
      rootKeyPair,
      logIdHex32: logHex32,
      mmrStart: opts.mmrStart,
      mmrEnd: opts.mmrEnd,
      delegatedPublicKey,
      expiresAt: opts.expiresAt ?? FAR_FUTURE,
    });
    if (!registered) {
      await registerEs256Root(logUuid, material.x, material.y);
      registered = true;
    }
    return postCertificateJson({
      logId: logHex32,
      mmrStart: opts.mmrStart.toString(),
      mmrEnd: opts.mmrEnd.toString(),
      delegatedPublicKey: bytesToBase64(delegatedPublicKey),
      certificate: bytesToBase64(material.certificate),
      issuedAt: material.issuedAt,
      expiresAt: material.expiresAt,
    });
  };
  return { logUuid, logHex32, submit };
}

/** Placeholder uint64 swapped for a float64 by {@link postIssue}. */
const FLOAT_SENTINEL = 0x1122334455667788n;

/**
 * POST /api/delegations (CBOR, as the sealer sends it). An `mmrEnd` of
 * `{ float64 }` is written as a CBOR float64 (major type 7), the shape
 * cbor-x produced above uint32; the canonical encoder refuses to emit one,
 * so a sentinel uint64 is patched in place.
 */
function postIssue(opts: {
  logHex32: string;
  mmrStart: unknown;
  mmrEnd: unknown;
  delegatedPublicKey: Uint8Array;
}): Promise<Response> {
  const float =
    typeof opts.mmrEnd === "object" && opts.mmrEnd !== null
      ? (opts.mmrEnd as { float64: number }).float64
      : undefined;
  const body = encodeCborDeterministic({
    version: 1,
    logId: hex32ToWireLogIdBytes(opts.logHex32),
    mmrStart: opts.mmrStart,
    mmrEnd: float === undefined ? opts.mmrEnd : FLOAT_SENTINEL,
    algorithm: "ES256",
    delegatedPublicKey: opts.delegatedPublicKey,
    requestedTtlSeconds: 3600,
  });
  if (float !== undefined) {
    const head = [0x1b, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88];
    const at = body.findIndex((_, i) =>
      head.every((b, j) => body[i + j] === b),
    );
    const patch = new Uint8Array(9);
    patch[0] = 0xfb;
    new DataView(patch.buffer).setFloat64(1, float, false);
    body.set(patch, at);
  }
  return fetchWithDoRetry("http://localhost/api/delegations", {
    method: "POST",
    headers: authHeaders({
      "Content-Type": "application/cbor",
      Accept: "application/cbor",
    }),
    body,
  });
}

interface ActiveLog {
  logIdHex32: string;
  expiresAt: number;
  mmrStart: string | null;
  mmrEnd: string | null;
}

/** Walk GET /api/delegations/active and return the row for one log. */
async function activeRowFor(logHex32: string): Promise<ActiveLog | undefined> {
  let cursor: string | null = null;
  for (let i = 0; i < 1000; i++) {
    const url = new URL("http://localhost/api/delegations/active");
    url.searchParams.set("limit", "500");
    if (cursor) url.searchParams.set("cursor", cursor);
    const res = await fetchWithDoRetry(url.toString(), {
      headers: authHeaders(),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      logs: ActiveLog[];
      cursor: string | null;
    };
    const row = body.logs.find((l) => l.logIdHex32 === logHex32);
    if (row) return row;
    cursor = body.cursor;
    if (cursor === null) return undefined;
  }
  throw new Error("active walk did not terminate");
}

describe("delegation MMR range is uint64 on the JSON routes", () => {
  it("accepts a certificate at 2^53+1..2^64-1 and echoes exact decimal strings", async () => {
    const log = await freshLog();
    const res = await log.submit({
      mmrStart: P53_PLUS_1,
      mmrEnd: U64_MAX,
      keySeed: 40,
    });
    expect(res.status).toBe(200);
    const { certificateKey } = (await res.json()) as {
      certificateKey: string;
    };
    expect(certificateKey.startsWith(`${P53_PLUS_1}:${U64_MAX}:`)).toBe(true);

    const del = await fetchWithDoRetry(
      `http://localhost/api/logs/${log.logUuid}/delegation`,
    );
    expect(del.status).toBe(200);
    const body = (await del.json()) as { mmrStart: unknown; mmrEnd: unknown };
    expect(body.mmrStart).toBe("9007199254740993");
    expect(body.mmrEnd).toBe("18446744073709551615");

    const active = await activeRowFor(log.logHex32);
    expect(active?.mmrStart).toBe("9007199254740993");
    expect(active?.mmrEnd).toBe("18446744073709551615");
  });

  it.each([
    ["a JSON number", 0, "7"],
    ["a JSON number end", "0", 7],
    ["a leading zero", "07", "9"],
    ["a sign", "+1", "9"],
    ["a negative", "-1", "9"],
    ["whitespace", " 1", "9"],
    ["a fraction", "1.0", "9"],
    ["an exponent", "1e3", "9999"],
    ["2^64", "0", "18446744073709551616"],
    ["null", null, "9"],
    ["start above end", "10", "9"],
  ])("rejects %s with 400", async (_label, mmrStart, mmrEnd) => {
    const res = await postCertificateJson({
      logId: normalizeLogIdToHex32(randomUUID()),
      mmrStart,
      mmrEnd,
      delegatedPublicKey: bytesToBase64(testDelegatedCoseKey(41)),
      certificate: bytesToBase64(new Uint8Array([0x80])),
      issuedAt: 1_700_000_000,
      expiresAt: FAR_FUTURE,
    });
    expect(res.status).toBe(400);
    const problem = (await res.json()) as { detail: string };
    expect(problem.detail).toMatch(/mmrStart|mmrEnd/);
  });

  it("serves a certificate covering a window above 2^63 to the sealer", async () => {
    const log = await freshLog();
    const keySeed = 42;
    expect(
      (await log.submit({ mmrStart: P53_PLUS_1, mmrEnd: U64_MAX, keySeed }))
        .status,
    ).toBe(200);

    const covered = await postIssue({
      logHex32: log.logHex32,
      mmrStart: P63,
      mmrEnd: P63 + 10n,
      delegatedPublicKey: testDelegatedCoseKey(keySeed),
    });
    expect(covered.status).toBe(200);
    const issued = decodeCborDeterministic(
      new Uint8Array(await covered.arrayBuffer()),
    ) as Map<string, unknown>;
    expect(issued.get("certificate")).toBeInstanceOf(Uint8Array);

    // Below the certificate's start: not covered, so the demand goes pending
    // and the pending surfaces carry the exact bounds as strings.
    const uncovered = await postIssue({
      logHex32: log.logHex32,
      mmrStart: P32,
      mmrEnd: P53_PLUS_1 - 1n,
      delegatedPublicKey: testDelegatedCoseKey(keySeed),
    });
    expect(uncovered.status).toBe(202);
    const pending = await fetchWithDoRetry(
      `http://localhost/api/logs/${log.logUuid}/pending-delegation`,
    );
    const { entries } = (await pending.json()) as { entries: PendingEntry[] };
    const entry = entries.find((e) => e.logIdHex32 === log.logHex32);
    expect(entry?.mmrStart).toBe("4294967296");
    expect(entry?.mmrEnd).toBe("9007199254740992");
  });

  it.each([
    ["a negative bound", -1, 5],
    [
      "a float64 bound (cbor-x's shape above uint32)",
      0,
      { float64: 2 ** 32 + 1 },
    ],
    ["a text bound", "0", "5"],
    ["start above end", 9, 5],
  ])("rejects an issue request with %s", async (_label, mmrStart, mmrEnd) => {
    const res = await postIssue({
      logHex32: normalizeLogIdToHex32(randomUUID()),
      mmrStart,
      mmrEnd,
      delegatedPublicKey: testDelegatedCoseKey(43),
    });
    expect(res.status).toBe(400);
  });

  it("orders ranges numerically across 2^32, 2^53 and 2^64-1 through the store", async () => {
    // Same key and expiry; each submit widens mmrEnd so none is stale.
    const log = await freshLog();
    const keySeed = 44;
    for (const [mmrStart, mmrEnd] of [
      [256n, P32],
      [P32 + 1n, P53_PLUS_1],
      [255n, U64_MAX],
    ] as const) {
      expect((await log.submit({ mmrStart, mmrEnd, keySeed })).status).toBe(
        200,
      );
    }

    // MIN(mmr_start) / MAX(mmr_end) over the BLOB columns.
    const active = await activeRowFor(log.logHex32);
    expect(active?.mmrStart).toBe("255");
    expect(active?.mmrEnd).toBe("18446744073709551615");

    // ORDER BY mmr_end DESC picks the widest.
    const del = await fetchWithDoRetry(
      `http://localhost/api/logs/${log.logUuid}/delegation`,
    );
    const current = (await del.json()) as { mmrEnd: string };
    expect(current.mmrEnd).toBe("18446744073709551615");

    // Staleness `mmr_end >= ?`: 2^53+1 is below the stored 2^64-1.
    const stale = await log.submit({
      mmrStart: 0n,
      mmrEnd: P53_PLUS_1,
      keySeed,
    });
    expect(stale.status).toBe(409);
    expect(((await stale.json()) as { detail: string }).detail).toContain(
      "mmrEnd=18446744073709551615",
    );
  });

  it("compares be8 BLOBs in numeric order in the DO's SQLite", async () => {
    const stub = env.DELEGATION_STORE.get(
      env.DELEGATION_STORE.idFromName(`be8-order-${randomUUID()}`),
    );
    const values = [
      0n,
      1n,
      255n,
      256n,
      P32 - 1n,
      P32,
      P32 + 1n,
      (1n << 53n) - 1n,
      1n << 53n,
      P53_PLUS_1,
      P63 - 1n,
      P63,
      U64_MAX - 1n,
      U64_MAX,
    ];
    await runInDurableObject(stub, async (_instance, state) => {
      const sql = state.storage.sql;
      sql.exec(`CREATE TABLE be8_order (v BLOB NOT NULL)`);
      // Insert shuffled so ORDER BY does the work.
      for (const v of [...values].reverse()) {
        sql.exec(`INSERT INTO be8_order (v) VALUES (?)`, encodeMmrIndexBe8(v));
      }
      const hex = (b: ArrayBuffer) =>
        BigInt(
          "0x" +
            [...new Uint8Array(b)]
              .map((x) => x.toString(16).padStart(2, "0"))
              .join(""),
        );
      const ordered = [...sql.exec(`SELECT v FROM be8_order ORDER BY v`)].map(
        (r) => hex(r.v as ArrayBuffer),
      );
      expect(ordered).toEqual(values);

      const agg = [
        ...sql.exec(`SELECT MIN(v) AS lo, MAX(v) AS hi FROM be8_order`),
      ][0]!;
      expect(hex(agg.lo as ArrayBuffer)).toBe(0n);
      expect(hex(agg.hi as ArrayBuffer)).toBe(U64_MAX);

      // Range predicates as the coverage query binds them.
      const between = [
        ...sql.exec(
          `SELECT COUNT(*) AS n FROM be8_order WHERE v >= ? AND v <= ?`,
          encodeMmrIndexBe8(P32),
          encodeMmrIndexBe8(P63),
        ),
      ][0]!;
      expect(between.n).toBe(7); // 2^32 .. 2^63 inclusive
    });
  });
});
