/**
 * In-place, chunked migration of the delegation MMR range columns from
 * SQLite INTEGER to 8-byte big-endian BLOB (fix-forward only;
 * src/durableobjects/mmr-range-migration.ts).
 *
 * Each test seeds a dedicated DO (never one of the worker's shards) with the
 * exact older table shapes before its first fetch, shrinks the
 * per-event budget through the DO's test seams where it needs several
 * events, and drives the rest with alarms.
 */

import { randomUUID } from "node:crypto";
import { encodeCborDeterministic } from "@forestrie/encoding";
import {
  env,
  runDurableObjectAlarm,
  runInDurableObject,
} from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { sha256Hex } from "../../src/certificate-key.js";
import type { DelegationStoreDO } from "../../src/durableobjects/delegation-store.js";
import {
  MmrRangeMigration,
  type MmrRangeMigrationBudget,
  type MmrRangeMigrationChunk,
  type MmrRangeMigrationChunkHook,
} from "../../src/durableobjects/mmr-range-migration.js";
import {
  hex32ToWireLogIdBytes,
  normalizeLogIdToHex32,
} from "../../src/log-id.js";
import type { PendingEntry } from "../../src/types/pending-entry.js";
import { testDelegatedCoseKey } from "./byok-material-fixture.js";

type Stub = DurableObjectStub<DelegationStoreDO>;

/** The private fields tests reach through (`rangeMigration*` seams). */
interface MigrationSeams {
  initialized: boolean;
  rangeMigrationBudget: MmrRangeMigrationBudget;
  rangeMigrationChunkHook: MmrRangeMigrationChunkHook | null;
}

const FAR_FUTURE = 4_102_444_800;
const CERT_BYTES = new Uint8Array([0xd2, 0x84, 0x40, 0xa0, 0xf6, 0x40]);
const LEGACY_CERT_BYTES = new Uint8Array([0xd2, 0x84, 0x41, 0x00]);
const TWO_53_PLUS_1 = 2n ** 53n + 1n;
const INT64_MAX = 2n ** 63n - 1n;
const TRIGGERS = [
  "trg_delegation_certificates_mmr_range_insert",
  "trg_delegation_certificates_mmr_range_update",
  "trg_pending_mmr_range_insert",
  "trg_pending_mmr_range_update",
];

/** The older table shapes, with INTEGER range columns: base CREATE plus the legacy ALTER path. */
function createLegacyTables(sql: SqlStorage): void {
  sql.exec(`
    CREATE TABLE delegation_certificates (
      log_id_hex32 TEXT NOT NULL,
      certificate_key TEXT NOT NULL,
      certificate BLOB NOT NULL,
      issued_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      PRIMARY KEY (log_id_hex32, certificate_key)
    )
  `);
  for (const col of [
    "onchain_signature BLOB",
    "onchain_root_alg TEXT",
    "delegated_pubkey_hash TEXT",
    "delegated_public_key BLOB",
    "mmr_start INTEGER",
    "mmr_end INTEGER",
    "onchain_authenticator_data BLOB",
    "onchain_client_data_json BLOB",
  ]) {
    sql.exec(`ALTER TABLE delegation_certificates ADD COLUMN ${col}`);
  }
  sql.exec(`
    CREATE INDEX idx_delegation_certificates_coverage
    ON delegation_certificates (log_id_hex32, expires_at, mmr_start, mmr_end)
  `);
  sql.exec(`
    CREATE TABLE pending (
      id TEXT PRIMARY KEY,
      auth_log_id_hex32 TEXT NOT NULL,
      log_id_hex32 TEXT NOT NULL,
      mmr_start INTEGER NOT NULL,
      mmr_end INTEGER NOT NULL,
      delegated_pubkey_hash TEXT NOT NULL,
      delegated_public_key BLOB NOT NULL,
      requested_at INTEGER NOT NULL
    )
  `);
  sql.exec(`
    CREATE UNIQUE INDEX idx_pending_log_range_pubkey
    ON pending (log_id_hex32, mmr_start, mmr_end, delegated_pubkey_hash)
  `);
  sql.exec(`
    CREATE INDEX idx_pending_auth_log
    ON pending (auth_log_id_hex32, requested_at DESC)
  `);
  sql.exec(`
    CREATE TABLE webhook_deliveries (
      request_key TEXT PRIMARY KEY,
      log_id_hex32 TEXT NOT NULL,
      webhook_url TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      attempt INTEGER NOT NULL DEFAULT 0,
      next_attempt_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    )
  `);
}

/**
 * A range value to seed. A `bigint` binds as its decimal string, which the
 * legacy INTEGER affinity stores as an exact INTEGER (the DO SQL API binds no
 * bigint); bytes bind as an ArrayBuffer (a BLOB); the rest as-is.
 */
type SeedValue = bigint | number | string | Uint8Array | null;

function bind(v: SeedValue): SqlStorageValue {
  if (typeof v === "bigint") return v.toString(10);
  if (v instanceof Uint8Array) return new Uint8Array(v).buffer as ArrayBuffer;
  return v;
}

/**
 * An unsigned COSE_Sign1 delegation certificate carrying `start..end` as
 * CBOR uint64 labels 3/4. The migration parses payloads but never verifies
 * signatures, so the signature is zeros.
 */
function certificateFor(
  logHex32: string,
  start: bigint,
  end: bigint,
  payloadEdit: (payload: Uint8Array) => Uint8Array = (p) => p,
): Uint8Array {
  const payload = encodeCborDeterministic(
    new Map<number, unknown>([
      [1, logHex32],
      [3, start],
      [4, end],
      [7, 1],
      [8, 1_700_000_000],
      [9, FAR_FUTURE],
      [10, new Uint8Array(16)],
    ]),
  );
  return encodeCborDeterministic([
    new Uint8Array([0xa0]),
    new Map(),
    payloadEdit(payload),
    new Uint8Array(64),
  ]);
}

/**
 * Re-encode label 4 (mmrEnd) as a CBOR float64 of the same value, as cbor-x
 * did for numbers above 2^32. `end` must take the 9-byte uint64 form
 * (`0x1b` + 8 bytes), which has the same length as a float64 (`0xfb` + 8).
 */
function float64MmrEnd(end: bigint): (payload: Uint8Array) => Uint8Array {
  return (payload) => {
    const uint = new Uint8Array(10);
    uint[0] = 0x04;
    uint[1] = 0x1b;
    new DataView(uint.buffer).setBigUint64(2, end, false);
    const at = indexOfBytes(payload, uint);
    if (at < 0) throw new Error("label 4 uint64 not found");
    const out = payload.slice();
    out[at + 1] = 0xfb;
    new DataView(out.buffer).setFloat64(at + 2, Number(end), false);
    return out;
  };
}

function indexOfBytes(haystack: Uint8Array, needle: Uint8Array): number {
  outer: for (let i = 0; i + needle.length <= haystack.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) continue outer;
    }
    return i;
  }
  return -1;
}

/** A real certificate for a uint64 range; placeholder bytes otherwise. */
function certificateBytesFor(
  logHex32: string,
  start: SeedValue,
  end: SeedValue,
): Uint8Array {
  if (start === null) return LEGACY_CERT_BYTES;
  const asU64 = (v: SeedValue) =>
    typeof v === "bigint" && v >= 0n
      ? v
      : typeof v === "number" && Number.isSafeInteger(v) && v >= 0
        ? BigInt(v)
        : null;
  const s = asU64(start);
  const e = asU64(end);
  return s !== null && e !== null && s <= e
    ? certificateFor(logHex32, s, e)
    : CERT_BYTES;
}

function insertCert(
  sql: SqlStorage,
  logHex32: string,
  key: string,
  start: SeedValue,
  end: SeedValue,
  pubkey: { hash: string; key: Uint8Array } | null = null,
  certificate: Uint8Array = certificateBytesFor(logHex32, start, end),
): void {
  sql.exec(
    `INSERT INTO delegation_certificates
       (log_id_hex32, certificate_key, certificate, issued_at, expires_at,
        delegated_pubkey_hash, delegated_public_key, mmr_start, mmr_end)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    logHex32,
    key,
    certificate,
    1_700_000_000,
    FAR_FUTURE,
    pubkey?.hash ?? null,
    pubkey?.key ?? null,
    bind(start),
    bind(end),
  );
}

function insertPending(
  sql: SqlStorage,
  id: string,
  logHex32: string,
  start: SeedValue,
  end: SeedValue,
  pubkey: { hash: string; key: Uint8Array },
): void {
  sql.exec(
    `INSERT INTO pending
       (id, auth_log_id_hex32, log_id_hex32, mmr_start, mmr_end,
        delegated_pubkey_hash, delegated_public_key, requested_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    id,
    logHex32,
    logHex32,
    bind(start),
    bind(end),
    pubkey.hash,
    pubkey.key,
    Math.floor(Date.now() / 1000),
  );
}

function insertWebhook(
  sql: SqlStorage,
  requestKey: string,
  logHex32: string,
  payload: Record<string, unknown>,
): void {
  sql.exec(
    `INSERT INTO webhook_deliveries
       (request_key, log_id_hex32, webhook_url, payload_json, attempt,
        next_attempt_at, created_at)
     VALUES (?, ?, ?, ?, 0, ?, ?)`,
    requestKey,
    logHex32,
    "https://hooks.example.test/legacy",
    JSON.stringify({ requestKey, ...payload }),
    FAR_FUTURE,
    Math.floor(Date.now() / 1000),
  );
}

function newStub(prefix: string): Stub {
  return env.DELEGATION_STORE.get(
    env.DELEGATION_STORE.idFromName(`${prefix}-${randomUUID()}`),
  );
}

/** Create the legacy tables, run `seed`, and install the test seams. */
async function seedLegacy(
  stub: Stub,
  seed: (sql: SqlStorage) => void,
  budget?: MmrRangeMigrationBudget,
): Promise<void> {
  await runInDurableObject(stub, async (instance, state) => {
    createLegacyTables(state.storage.sql);
    seed(state.storage.sql);
    if (budget) {
      (instance as unknown as MigrationSeams).rangeMigrationBudget = budget;
    }
  });
}

async function setChunkHook(
  stub: Stub,
  hook: (sql: SqlStorage) => MmrRangeMigrationChunkHook | null,
): Promise<void> {
  await runInDurableObject(stub, async (instance, state) => {
    (instance as unknown as MigrationSeams).rangeMigrationChunkHook = hook(
      state.storage.sql,
    );
  });
}

/** Storage facts the assertions read, straight from SQL. */
interface Inspected {
  done: boolean;
  triggers: string[];
  leftoverTables: string[];
  /** `certificate_key` → [hex(mmr_start), hex(mmr_end)] ('' for NULL). */
  certHex: Record<string, [string, string]>;
  certTypes: string[];
  pendingHex: Record<string, [string, string]>;
  quarantine: Record<string, string>;
  payloads: Record<string, Record<string, unknown>>;
}

async function inspect(stub: Stub): Promise<Inspected> {
  return runInDurableObject(stub, async (_instance, state) => {
    const sql = state.storage.sql;
    const rows = (q: string) => [...sql.exec(q)];
    const tableExists = (name: string) =>
      rows(
        `SELECT name FROM sqlite_master WHERE type = 'table' AND name = '${name}'`,
      ).length > 0;
    const certHex: Inspected["certHex"] = {};
    const certTypes: string[] = [];
    for (const r of rows(
      `SELECT certificate_key, hex(mmr_start) AS s, hex(mmr_end) AS e,
              typeof(mmr_start) AS ts, typeof(mmr_end) AS te
         FROM delegation_certificates`,
    )) {
      certHex[String(r.certificate_key)] = [String(r.s), String(r.e)];
      certTypes.push(`${String(r.ts)}/${String(r.te)}`);
    }
    const pendingHex: Inspected["pendingHex"] = {};
    for (const r of rows(
      `SELECT id, hex(mmr_start) AS s, hex(mmr_end) AS e FROM pending`,
    )) {
      pendingHex[String(r.id)] = [String(r.s), String(r.e)];
    }
    const quarantine: Record<string, string> = {};
    if (tableExists("delegation_certificates_quarantine")) {
      for (const r of rows(
        `SELECT certificate_key, reason FROM delegation_certificates_quarantine`,
      )) {
        quarantine[String(r.certificate_key)] = String(r.reason);
      }
    }
    const payloads: Inspected["payloads"] = {};
    for (const r of rows(
      `SELECT request_key, payload_json FROM webhook_deliveries`,
    )) {
      payloads[String(r.request_key)] = JSON.parse(String(r.payload_json));
    }
    return {
      done:
        tableExists("schema_meta") &&
        rows(`SELECT 1 FROM schema_meta WHERE key = 'mmr_range_be8'`).length >
          0,
      triggers: rows(
        `SELECT name FROM sqlite_master WHERE type = 'trigger' ORDER BY name`,
      ).map((r) => String(r.name)),
      leftoverTables: rows(
        `SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE '%__be8'`,
      ).map((r) => String(r.name)),
      certHex,
      certTypes,
      pendingHex,
      quarantine,
      payloads,
    };
  });
}

/**
 * Drive the migration with alarms only (no fetches) until the done flag is
 * set. Alarms may also fire on their own; either way the flag must arrive.
 */
async function driveAlarmsToCompletion(stub: Stub): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if ((await inspect(stub)).done) return;
    if (!(await runDurableObjectAlarm(stub))) {
      await new Promise((r) => setTimeout(r, 10));
    }
  }
  throw new Error("range migration did not complete");
}

/**
 * Sum the rows each event examined: a chunk with `chunkInEvent === 0` opens
 * a new event.
 */
function examinedPerEvent(chunks: MmrRangeMigrationChunk[]): number[] {
  const out: number[] = [];
  for (const c of chunks) {
    if (c.chunkInEvent === 0) out.push(0);
    out[out.length - 1]! += c.examined;
  }
  return out;
}

async function schemaMetaKeys(stub: Stub): Promise<string[]> {
  return runInDurableObject(stub, async (_i, state) =>
    [...state.storage.sql.exec(`SELECT key FROM schema_meta ORDER BY key`)].map(
      (r) => String(r.key),
    ),
  );
}

function be8Hex(v: bigint): string {
  return v.toString(16).padStart(16, "0").toUpperCase();
}

async function getDelegation(stub: Stub, logHex32: string): Promise<Response> {
  return stub.fetch(`https://do.internal/delegation?logId=${logHex32}`);
}

describe("MMR range INTEGER → be8 BLOB in-place migration", () => {
  it("migrates more rows than several budgets: 503 meanwhile, alarms finish it", async () => {
    const stub = newStub("range-migration-large");
    const logs = Array.from({ length: 12 }, () =>
      normalizeLogIdToHex32(randomUUID()),
    );
    const bigLog = normalizeLogIdToHex32(randomUUID());
    const legacyLog = normalizeLogIdToHex32(randomUUID());
    const key = testDelegatedCoseKey(61);
    const pubkey = { hash: await sha256Hex(key), key };
    const expectedCert: Record<string, [string, string]> = {};
    const expectedPending: Record<string, [string, string]> = {};
    const chunkCalls: MmrRangeMigrationChunk[] = [];

    await seedLegacy(
      stub,
      (sql) => {
        logs.forEach((log, i) => {
          const start = BigInt(i) * 1000n;
          const end = start + 999n;
          insertCert(sql, log, `c${i}`, start, end, pubkey);
          expectedCert[`c${i}`] = [be8Hex(start), be8Hex(end)];
          insertPending(sql, `p${i}`, log, end + 1n, end + 2n, pubkey);
          expectedPending[`p${i}`] = [be8Hex(end + 1n), be8Hex(end + 2n)];
        });
        insertCert(sql, bigLog, "big", TWO_53_PLUS_1, INT64_MAX, pubkey);
        expectedCert.big = [be8Hex(TWO_53_PLUS_1), be8Hex(INT64_MAX)];
        // Pre-coverage row: NULL range, keyed `start:end:pubkeyHash`.
        insertCert(sql, legacyLog, `3:4:${pubkey.hash}`, null, null);
        expectedCert[`3:4:${pubkey.hash}`] = ["", ""];
        // Leftovers from the earlier rebuild-based build of this migration.
        sql.exec(`CREATE TABLE delegation_certificates__be8 (x)`);
        sql.exec(`CREATE TABLE pending__be8 (x)`);
      },
      { chunkRows: 3, eventRows: 6, eventMs: 60_000 },
    );
    await setChunkHook(stub, () => (chunk) => {
      chunkCalls.push(chunk);
    });

    // First event converts at most one budget: range routes are refused.
    const first = await getDelegation(stub, bigLog);
    expect(first.status).toBe(503);
    expect(first.headers.get("Retry-After")).toBe("1");
    const pending = await stub.fetch(
      `https://do.internal/pending-delegation?logId=${logs[0]}`,
    );
    expect(pending.status).toBe(503);
    // A route that never touches ranges proceeds.
    const webhook = await stub.fetch(`https://do.internal/webhook/${logs[0]}`);
    expect(webhook.status).not.toBe(503);

    await driveAlarmsToCompletion(stub);

    const after = await inspect(stub);
    expect(after.certHex).toEqual(expectedCert);
    expect(after.pendingHex).toEqual(expectedPending);
    expect(after.leftoverTables).toEqual([]);
    expect(after.triggers).toEqual(TRIGGERS);
    expect(after.quarantine).toEqual({});
    // 26 range rows at 3 per chunk and 6 per event: several events ran.
    const perEvent = examinedPerEvent(chunkCalls);
    expect(perEvent.length).toBeGreaterThanOrEqual(4);
    expect(Math.max(...perEvent)).toBeLessThanOrEqual(6);
    expect(await schemaMetaKeys(stub)).toEqual(["mmr_range_be8"]);

    const del = await getDelegation(stub, bigLog);
    expect(del.status).toBe(200);
    const current = (await del.json()) as { mmrStart: string; mmrEnd: string };
    expect(current.mmrStart).toBe(TWO_53_PLUS_1.toString());
    expect(current.mmrEnd).toBe(INT64_MAX.toString());

    // Pre-coverage row: still NULL, still served by the exact certificate_key.
    const issue = await stub.fetch("https://do.internal/issue", {
      method: "POST",
      headers: { "Content-Type": "application/cbor" },
      body: encodeCborDeterministic({
        logId: hex32ToWireLogIdBytes(legacyLog),
        mmrStart: 3,
        mmrEnd: 4,
        algorithm: "ES256",
        delegatedPublicKey: key,
      }),
    });
    expect(issue.status).toBe(200);

    const pendingAfter = await stub.fetch(
      `https://do.internal/pending-delegation?logId=${logs[11]}`,
    );
    const { entries } = (await pendingAfter.json()) as {
      entries: PendingEntry[];
    };
    const entry = entries.find((e) => e.id === "p11");
    expect(entry?.mmrStart).toBe("12000");
    expect(entry?.mmrEnd).toBe("12001");
  });

  it("resumes after a chunk fails mid-transaction", async () => {
    const stub = newStub("range-migration-interrupted");
    const log = normalizeLogIdToHex32(randomUUID());
    const key = testDelegatedCoseKey(63);
    const pubkey = { hash: await sha256Hex(key), key };
    const expected: Record<string, [string, string]> = {};
    await seedLegacy(
      stub,
      (sql) => {
        for (let i = 0; i < 10; i++) {
          const v = 2n ** 40n + BigInt(i);
          insertCert(sql, log, `c${i}`, v, v + 1n, pubkey);
          expected[`c${i}`] = [be8Hex(v), be8Hex(v + 1n)];
        }
      },
      { chunkRows: 3, eventRows: 100, eventMs: 60_000 },
    );

    // Fail the second certificate chunk once, after its writes, before
    // commit; record what that chunk saw so the rollback can be checked.
    const seenMidChunk: string[][] = [];
    let failed = false;
    let certChunks = 0;
    await setChunkHook(stub, (sql) => ({ phase, examined }) => {
      if (failed || phase !== "delegation_certificates" || examined === 0) {
        return;
      }
      if (++certChunks !== 2) return;
      failed = true;
      seenMidChunk.push(
        [
          ...sql.exec(
            `SELECT typeof(mmr_start) AS t FROM delegation_certificates`,
          ),
        ].map((r) => String(r.t)),
      );
      throw new Error("injected chunk failure");
    });

    const res = await getDelegation(stub, log);
    expect(res.status).toBe(503);
    // Mid-chunk: two chunks' rows written, the rest still INTEGER — only
    // ever visible inside the transaction that then rolled back.
    expect(seenMidChunk[0]!.filter((t) => t === "blob")).toHaveLength(6);
    expect(seenMidChunk[0]!.filter((t) => t === "integer")).toHaveLength(4);

    await driveAlarmsToCompletion(stub);
    const after = await inspect(stub);
    expect(after.certHex).toEqual(expected);
    expect(after.triggers).toEqual(TRIGGERS);
    expect((await getDelegation(stub, log)).status).toBe(200);
  });

  it("quarantines certificates whose range is not a uint64 and deletes bad pending rows", async () => {
    const stub = newStub("range-migration-quarantine");
    const key = testDelegatedCoseKey(64);
    const pubkey = { hash: await sha256Hex(key), key };
    const badLogs = {
      real: normalizeLogIdToHex32(randomUUID()),
      negative: normalizeLogIdToHex32(randomUUID()),
      text: normalizeLogIdToHex32(randomUUID()),
      short: normalizeLogIdToHex32(randomUUID()),
    };
    const goodLog = normalizeLogIdToHex32(randomUUID());
    await seedLegacy(stub, (sql) => {
      // INTEGER affinity turns 5.0 or '5' into integer 5, so the bad values
      // are ones it cannot convert.
      insertCert(sql, badLogs.real, "real", 1.5, 10, pubkey);
      insertCert(sql, badLogs.negative, "negative", 0, -1, pubkey);
      insertCert(sql, badLogs.text, "text", "not-a-number", 10, pubkey);
      insertCert(sql, badLogs.short, "short", new Uint8Array(4), 10, pubkey);
      insertCert(sql, goodLog, "good", 0, 10, pubkey);
      insertPending(sql, "bad-pending", goodLog, 2.5, 3, pubkey);
      insertPending(sql, "good-pending", goodLog, 20, 30, pubkey);
    });

    expect((await getDelegation(stub, goodLog)).status).toBe(200);
    const after = await inspect(stub);
    expect(after.done).toBe(true);
    expect(after.quarantine).toEqual({
      real: "mmr_start is real",
      negative: "mmr_end is negative",
      text: "mmr_start is text",
      short: "mmr_start is a 4-byte blob",
    });
    expect(Object.keys(after.certHex)).toEqual(["good"]);
    expect(Object.keys(after.pendingHex)).toEqual(["good-pending"]);
    for (const log of Object.values(badLogs)) {
      expect((await getDelegation(stub, log)).status).toBe(404);
    }
  });

  it("installs triggers that reject a non-be8 range once complete", async () => {
    const stub = newStub("range-migration-triggers");
    const log = normalizeLogIdToHex32(randomUUID());
    const key = testDelegatedCoseKey(65);
    const pubkey = { hash: await sha256Hex(key), key };
    await seedLegacy(stub, (sql) => {
      insertCert(sql, log, "c0", 1, 2, pubkey);
    });
    expect((await getDelegation(stub, log)).status).toBe(200);

    await runInDurableObject(stub, async (_instance, state) => {
      const sql = state.storage.sql;
      const reject = /8-byte big-endian BLOB/;
      expect(() => insertCert(sql, log, "c1", 5, 6, pubkey)).toThrow(reject);
      expect(() => insertPending(sql, "p-int", log, 5, 6, pubkey)).toThrow(
        reject,
      );
      expect(() =>
        sql.exec(`UPDATE delegation_certificates SET mmr_end = 7`),
      ).toThrow(reject);
      // A be8 BLOB and a NULL range still pass.
      insertCert(sql, log, "c2", new Uint8Array(8), new Uint8Array(8), pubkey);
      insertCert(sql, log, "c3", null, null);
    });
  });

  it("rewrites queued webhook payload ranges across several chunks", async () => {
    const stub = newStub("range-migration-webhooks");
    const log = normalizeLogIdToHex32(randomUUID());
    const chunks: string[] = [];
    await seedLegacy(
      stub,
      (sql) => {
        for (let i = 0; i < 7; i++) {
          insertWebhook(sql, `rk${i}`, log, {
            type: "delegation.required",
            logId: log,
            mmrStart: 4294967296 + i,
            mmrEnd: 4294967297 + i,
          });
        }
        insertWebhook(sql, "rk-windowless", log, { logId: log });
        insertWebhook(sql, "rk-negative", log, { mmrStart: -1, mmrEnd: 2 });
      },
      { chunkRows: 2, eventRows: 4, eventMs: 60_000 },
    );
    await setChunkHook(stub, () => ({ phase }) => {
      if (phase === "webhook_deliveries") chunks.push(phase);
    });

    await stub.fetch(`https://do.internal/webhook/${log}`);
    await driveAlarmsToCompletion(stub);

    const after = await inspect(stub);
    for (let i = 0; i < 7; i++) {
      const p = after.payloads[`rk${i}`]!;
      expect(p.mmrStart).toBe(String(4294967296 + i));
      expect(p.mmrEnd).toBe(String(4294967297 + i));
      expect(p.requestKey).toBe(`rk${i}`);
    }
    expect(after.payloads["rk-windowless"]).toEqual({
      requestKey: "rk-windowless",
      logId: log,
    });
    expect(after.payloads["rk-negative"]).toBeUndefined();
    // 8 numeric payloads at 2 per chunk, plus the empty closing scans.
    expect(chunks.length).toBeGreaterThanOrEqual(4);
  });

  it("does no work on a fresh database: done flag and triggers at once", async () => {
    const stub = newStub("range-migration-fresh");
    // The very first event completes: a range route answers, not 503.
    const res = await getDelegation(stub, "0".repeat(32));
    expect(res.status).toBe(404);
    const after = await inspect(stub);
    expect(after.done).toBe(true);
    expect(after.triggers).toEqual(TRIGGERS);
    expect(after.leftoverTables).toEqual([]);
    const declared = await runInDurableObject(stub, async (_i, state) =>
      [
        ...state.storage.sql.exec(
          `SELECT name, type FROM pragma_table_info('pending')
            WHERE name IN ('mmr_start', 'mmr_end')`,
        ),
      ].map((r) => `${String(r.name)}:${String(r.type)}`),
    );
    expect(declared).toEqual(["mmr_start:BLOB", "mmr_end:BLOB"]);
  });

  it("examines at most the window budget per event when most rows are already be8", async () => {
    const stub = newStub("range-migration-mostly-be8");
    const log = normalizeLogIdToHex32(randomUUID());
    const key = testDelegatedCoseKey(67);
    const pubkey = { hash: await sha256Hex(key), key };
    const expected: Record<string, [string, string]> = {};
    const chunks: MmrRangeMigrationChunk[] = [];
    await seedLegacy(
      stub,
      (sql) => {
        for (let i = 0; i < 40; i++) {
          const v = BigInt(i) * 10n;
          // Every tenth row is still INTEGER; the rest are already be8.
          const asInt = i % 10 === 9;
          const enc = (x: bigint) => {
            const b = new Uint8Array(8);
            new DataView(b.buffer).setBigUint64(0, x, false);
            return b;
          };
          insertCert(
            sql,
            log,
            `c${i}`,
            asInt ? v : enc(v),
            asInt ? v + 5n : enc(v + 5n),
            pubkey,
          );
          expected[`c${i}`] = [be8Hex(v), be8Hex(v + 5n)];
        }
      },
      { chunkRows: 4, eventRows: 8, eventMs: 60_000 },
    );
    await setChunkHook(stub, () => (chunk) => {
      chunks.push(chunk);
    });

    expect((await getDelegation(stub, log)).status).toBe(503);
    await driveAlarmsToCompletion(stub);

    const perEvent = examinedPerEvent(chunks);
    // 40 rows at 8 per event: every row is examined once, in bounded events.
    expect(perEvent.reduce((a, b) => a + b, 0)).toBe(40);
    expect(Math.max(...perEvent)).toBeLessThanOrEqual(8);
    expect(perEvent.length).toBeGreaterThanOrEqual(5);
    for (const c of chunks) expect(c.examined).toBeLessThanOrEqual(4);
    expect((await inspect(stub)).certHex).toEqual(expected);
    expect(await schemaMetaKeys(stub)).toEqual(["mmr_range_be8"]);
  });

  it("resumes from the persisted cursor after eviction", async () => {
    const stub = newStub("range-migration-evicted");
    const log = normalizeLogIdToHex32(randomUUID());
    const key = testDelegatedCoseKey(68);
    const pubkey = { hash: await sha256Hex(key), key };
    const expected: Record<string, [string, string]> = {};
    await seedLegacy(
      stub,
      (sql) => {
        for (let i = 0; i < 30; i++) {
          insertCert(sql, log, `c${i}`, BigInt(i), BigInt(i) + 1n, pubkey);
          expected[`c${i}`] = [be8Hex(BigInt(i)), be8Hex(BigInt(i) + 1n)];
        }
      },
      { chunkRows: 4, eventRows: 8, eventMs: 60_000 },
    );
    // The first event may convert two windows; after that the DO's own
    // events (alarms) make no progress, so the cursor is deterministic.
    let windowsAllowed = 2;
    await setChunkHook(stub, () => (chunk) => {
      if (chunk.examined === 0) return;
      if (windowsAllowed-- <= 0) throw new Error("paused for the test");
    });
    expect((await getDelegation(stub, log)).status).toBe(503);

    // A fresh migration object (no in-memory state, as after eviction)
    // resumes from the cursor persisted with the last committed window.
    await runInDurableObject(stub, async (instance, state) => {
      const progress = [
        ...state.storage.sql.exec(
          `SELECT value FROM schema_meta WHERE key = 'mmr_range_be8_progress'`,
        ),
      ];
      expect(progress).toHaveLength(1);
      const before = JSON.parse(String(progress[0]!.value)) as {
        phase: string;
        cursor: number;
      };
      expect(before.phase).toBe("delegation_certificates");
      expect(before.cursor).toBe(8);

      const seen: MmrRangeMigrationChunk[] = [];
      const fresh = new MmrRangeMigration(state.storage);
      fresh.run({ chunkRows: 4, eventRows: 4, eventMs: 60_000 }, (c) => {
        seen.push(c);
      });
      const window = seen.find((c) => c.examined > 0)!;
      expect(window.from).toBe(before.cursor);
      while (!fresh.run({ chunkRows: 4, eventRows: 8, eventMs: 60_000 })) {
        // keep going
      }
      (instance as unknown as MigrationSeams).rangeMigrationChunkHook = null;
    });

    await runInDurableObject(stub, async (instance) => {
      (instance as unknown as MigrationSeams).initialized = false;
    });
    expect((await getDelegation(stub, log)).status).toBe(200);
    expect((await inspect(stub)).certHex).toEqual(expected);
    expect(await schemaMetaKeys(stub)).toEqual(["mmr_range_be8"]);
  });

  it("quarantines a certificate whose payload range the strict parser rejects or contradicts", async () => {
    const stub = newStub("range-migration-payload");
    const key = testDelegatedCoseKey(69);
    const pubkey = { hash: await sha256Hex(key), key };
    const floatLog = normalizeLogIdToHex32(randomUUID());
    const mismatchLog = normalizeLogIdToHex32(randomUUID());
    const goodLog = normalizeLogIdToHex32(randomUUID());
    const end = 2n ** 32n + 1n;
    await seedLegacy(stub, (sql) => {
      // cbor-x wrote label 4 as a float64; the columns still hold integers.
      insertCert(
        sql,
        floatLog,
        "float",
        0n,
        end,
        pubkey,
        certificateFor(floatLog, 0n, end, float64MmrEnd(end)),
      );
      // The signed range says 0..10; the columns say 0..11.
      insertCert(
        sql,
        mismatchLog,
        "mismatch",
        0n,
        11n,
        pubkey,
        certificateFor(mismatchLog, 0n, 10n),
      );
      insertCert(sql, goodLog, "good", 0n, end, pubkey);
    });

    expect((await getDelegation(stub, goodLog)).status).toBe(200);
    const after = await inspect(stub);
    expect(Object.keys(after.certHex)).toEqual(["good"]);
    expect(after.quarantine.float).toMatch(
      /^certificate payload rejected: .*mmrEnd/,
    );
    expect(after.quarantine.mismatch).toBe(
      "certificate payload range 0..10 disagrees with columns 0..11",
    );
    expect((await getDelegation(stub, floatLog)).status).toBe(404);
    expect((await getDelegation(stub, mismatchLog)).status).toBe(404);
  });

  it("re-arms the alarm with backoff when a chunk fails in alarm()", async () => {
    const stub = newStub("range-migration-alarm-backoff");
    const log = normalizeLogIdToHex32(randomUUID());
    const key = testDelegatedCoseKey(71);
    const pubkey = { hash: await sha256Hex(key), key };
    await seedLegacy(stub, (sql) => {
      insertCert(sql, log, "c0", 1n, 2n, pubkey);
    });
    await setChunkHook(stub, () => () => {
      throw new Error("injected chunk failure");
    });
    expect((await getDelegation(stub, log)).status).toBe(503);

    // The alarm swallows the failure and re-arms in the future.
    await runDurableObjectAlarm(stub);
    const rearmed = await runInDurableObject(stub, async (_i, state) =>
      state.storage.getAlarm(),
    );
    expect(rearmed).not.toBeNull();
    expect(rearmed!).toBeGreaterThan(Date.now() + 500);
    expect((await inspect(stub)).done).toBe(false);

    await setChunkHook(stub, () => null);
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    const after = await inspect(stub);
    expect(after.done).toBe(true);
    expect(await schemaMetaKeys(stub)).toEqual(["mmr_range_be8"]);
  });

  it("is idempotent: a second boot after completion changes nothing", async () => {
    const stub = newStub("range-migration-reboot");
    const log = normalizeLogIdToHex32(randomUUID());
    const key = testDelegatedCoseKey(66);
    const pubkey = { hash: await sha256Hex(key), key };
    await seedLegacy(stub, (sql) => {
      insertCert(sql, log, "c0", 7, INT64_MAX, pubkey);
    });
    expect((await getDelegation(stub, log)).status).toBe(200);
    const first = await inspect(stub);

    await runInDurableObject(stub, async (instance) => {
      (instance as unknown as MigrationSeams).initialized = false;
    });
    expect((await getDelegation(stub, log)).status).toBe(200);
    expect(await inspect(stub)).toEqual(first);
  });
});
