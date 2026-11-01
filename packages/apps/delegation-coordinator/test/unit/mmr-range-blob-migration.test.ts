/**
 * Boot-time migration of the delegation MMR range columns from SQLite
 * INTEGER to 8-byte big-endian BLOB (plan-2611-01 D2, FOR-613).
 *
 * Seeds a dedicated DO (never one of the worker's shards) with the exact
 * pre-FOR-613 `delegation_certificates`, `pending` and `webhook_deliveries`
 * shapes and rows, then lets the first fetch run ensureSchema. Rows must
 * survive with the same values, the range indexes must exist on the rebuilt
 * tables, and a second boot must change nothing.
 */

import { randomUUID } from "node:crypto";
import { encodeCborDeterministic } from "@forestrie/encoding";
import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { sha256Hex } from "../../src/certificate-key.js";
import type { DelegationStoreDO } from "../../src/durableobjects/delegation-store.js";
import {
  hex32ToWireLogIdBytes,
  normalizeLogIdToHex32,
} from "../../src/log-id.js";
import type { PendingEntry } from "../../src/types/pending-entry.js";
import { testDelegatedCoseKey } from "./byok-material-fixture.js";

const FAR_FUTURE = 4_102_444_800;
const CERT_BYTES = new Uint8Array([0xd2, 0x84, 0x40, 0xa0, 0xf6, 0x40]);
const LEGACY_CERT_BYTES = new Uint8Array([0xd2, 0x84, 0x41, 0x00]);

/** The pre-FOR-613 table shapes: base CREATE plus the legacy ALTER path. */
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

interface Seeded {
  stub: DurableObjectStub<DelegationStoreDO>;
  logHex32: string;
  legacyLogHex32: string;
  delegatedKey: Uint8Array;
  pendingKey: Uint8Array;
}

/** Seed legacy-schema rows into a fresh DO without booting its schema. */
async function seedLegacyStore(): Promise<Seeded> {
  const stub = env.DELEGATION_STORE.get(
    env.DELEGATION_STORE.idFromName(`range-blob-migration-${randomUUID()}`),
  );
  const logHex32 = normalizeLogIdToHex32(randomUUID());
  const legacyLogHex32 = normalizeLogIdToHex32(randomUUID());
  const delegatedKey = testDelegatedCoseKey(61);
  const pendingKey = testDelegatedCoseKey(62);
  const delegatedHash = await sha256Hex(delegatedKey);
  const pendingHash = await sha256Hex(pendingKey);
  const now = Math.floor(Date.now() / 1000);

  await runInDurableObject(stub, async (_instance, state) => {
    const sql = state.storage.sql;
    createLegacyTables(sql);
    // A coverage-era row with a range at the edge of what a JSON number
    // could carry exactly.
    sql.exec(
      `INSERT INTO delegation_certificates
         (log_id_hex32, certificate_key, certificate, issued_at, expires_at,
          delegated_pubkey_hash, delegated_public_key, mmr_start, mmr_end)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      logHex32,
      `0:${Number.MAX_SAFE_INTEGER}:${delegatedHash}`,
      CERT_BYTES,
      1_700_000_000,
      FAR_FUTURE,
      delegatedHash,
      delegatedKey,
      0,
      Number.MAX_SAFE_INTEGER,
    );
    // A pre-coverage row: NULL range columns, served by exact key only.
    sql.exec(
      `INSERT INTO delegation_certificates
         (log_id_hex32, certificate_key, certificate, issued_at, expires_at)
       VALUES (?, ?, ?, ?, ?)`,
      legacyLogHex32,
      `3:4:${delegatedHash}`,
      LEGACY_CERT_BYTES,
      1_700_000_000,
      FAR_FUTURE,
    );
    sql.exec(
      `INSERT INTO pending
         (id, auth_log_id_hex32, log_id_hex32, mmr_start, mmr_end,
          delegated_pubkey_hash, delegated_public_key, requested_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      "pending-1",
      logHex32,
      logHex32,
      4294967296,
      4294967297,
      pendingHash,
      pendingKey,
      now,
    );
    sql.exec(
      `INSERT INTO webhook_deliveries
         (request_key, log_id_hex32, webhook_url, payload_json, attempt,
          next_attempt_at, created_at)
       VALUES (?, ?, ?, ?, 2, ?, ?)`,
      "rk-windowed",
      logHex32,
      "https://hooks.example.test/legacy",
      JSON.stringify({
        requestKey: "rk-windowed",
        type: "delegation.required",
        version: 1,
        logId: logHex32,
        authLogId: logHex32,
        mmrStart: 4294967296,
        mmrEnd: 4294967297,
        delegatedPublicKey: "AA==",
        requestedAt: now,
      }),
      FAR_FUTURE,
      now,
    );
    sql.exec(
      `INSERT INTO webhook_deliveries
         (request_key, log_id_hex32, webhook_url, payload_json, attempt,
          next_attempt_at, created_at)
       VALUES (?, ?, ?, ?, 0, ?, ?)`,
      "rk-windowless",
      logHex32,
      "https://hooks.example.test/legacy",
      JSON.stringify({ requestKey: "rk-windowless", logId: logHex32 }),
      FAR_FUTURE,
      now,
    );
  });
  return { stub, logHex32, legacyLogHex32, delegatedKey, pendingKey };
}

/** Column storage classes, range values and indexes, read straight from SQL. */
async function inspect(stub: DurableObjectStub<DelegationStoreDO>): Promise<{
  certTypes: string[];
  pendingTypes: string[];
  indexes: string[];
  declared: Record<string, string>;
  payloads: Record<string, unknown>;
}> {
  return runInDurableObject(stub, async (_instance, state) => {
    const sql = state.storage.sql;
    const certTypes = [
      ...sql.exec(
        `SELECT typeof(mmr_start) AS s, typeof(mmr_end) AS e
           FROM delegation_certificates ORDER BY certificate_key`,
      ),
    ].map((r) => `${r.s}/${r.e}`);
    const pendingTypes = [
      ...sql.exec(
        `SELECT typeof(mmr_start) AS s, typeof(mmr_end) AS e FROM pending`,
      ),
    ].map((r) => `${r.s}/${r.e}`);
    const indexes = [
      ...sql.exec(
        `SELECT name FROM sqlite_master
          WHERE type = 'index' AND tbl_name IN ('pending', 'delegation_certificates')
            AND name LIKE 'idx_%' ORDER BY name`,
      ),
    ].map((r) => r.name as string);
    const declared: Record<string, string> = {};
    for (const table of ["delegation_certificates", "pending"]) {
      for (const r of sql.exec(
        `SELECT name, type FROM pragma_table_info('${table}')
          WHERE name IN ('mmr_start', 'mmr_end')`,
      )) {
        declared[`${table}.${r.name as string}`] = r.type as string;
      }
    }
    const payloads: Record<string, unknown> = {};
    for (const r of sql.exec(
      `SELECT request_key, payload_json FROM webhook_deliveries`,
    )) {
      payloads[r.request_key as string] = JSON.parse(r.payload_json as string);
    }
    return { certTypes, pendingTypes, indexes, declared, payloads };
  });
}

/** Assert the migrated rows read back with their original values. */
async function expectMigratedValues(s: Seeded): Promise<void> {
  // Coverage-era row: served through coverage retrieval from BLOB columns.
  const issue = await s.stub.fetch("https://do.internal/issue", {
    method: "POST",
    headers: { "Content-Type": "application/cbor" },
    body: encodeCborDeterministic({
      logId: hex32ToWireLogIdBytes(s.logHex32),
      mmrStart: 5,
      mmrEnd: 7,
      algorithm: "ES256",
      delegatedPublicKey: s.delegatedKey,
    }),
  });
  expect(issue.status).toBe(200);

  const del = await s.stub.fetch(
    `https://do.internal/delegation?logId=${s.logHex32}`,
  );
  expect(del.status).toBe(200);
  const current = (await del.json()) as { mmrStart: string; mmrEnd: string };
  expect(current.mmrStart).toBe("0");
  expect(current.mmrEnd).toBe(String(Number.MAX_SAFE_INTEGER));

  // Pre-coverage row: still NULL, still served by the exact certificate_key.
  const legacy = await s.stub.fetch("https://do.internal/issue", {
    method: "POST",
    headers: { "Content-Type": "application/cbor" },
    body: encodeCborDeterministic({
      logId: hex32ToWireLogIdBytes(s.legacyLogHex32),
      mmrStart: 3,
      mmrEnd: 4,
      algorithm: "ES256",
      delegatedPublicKey: s.delegatedKey,
    }),
  });
  expect(legacy.status).toBe(200);

  const pending = await s.stub.fetch(
    `https://do.internal/pending-delegation?logId=${s.logHex32}`,
  );
  const { entries } = (await pending.json()) as { entries: PendingEntry[] };
  const entry = entries.find((e) => e.id === "pending-1");
  expect(entry?.mmrStart).toBe("4294967296");
  expect(entry?.mmrEnd).toBe("4294967297");
}

describe("MMR range INTEGER → be8 BLOB boot-time migration", () => {
  it("rebuilds both tables with BLOB range columns and keeps every value", async () => {
    const seeded = await seedLegacyStore();
    const before = await inspect(seeded.stub);
    expect(before.declared["pending.mmr_start"]).toBe("INTEGER");

    await expectMigratedValues(seeded);

    const after = await inspect(seeded.stub);
    expect(after.declared).toEqual({
      "delegation_certificates.mmr_start": "BLOB",
      "delegation_certificates.mmr_end": "BLOB",
      "pending.mmr_start": "BLOB",
      "pending.mmr_end": "BLOB",
    });
    expect(after.certTypes.sort()).toEqual(["blob/blob", "null/null"]);
    expect(after.pendingTypes).toEqual(["blob/blob"]);
    expect(after.indexes).toEqual([
      "idx_delegation_certificates_coverage",
      "idx_pending_auth_log",
      "idx_pending_log_range_pubkey",
    ]);

    // In-flight webhook payloads move to the decimal-string contract too, so
    // a retry after deploy reaches a new-build receiver in a shape it parses.
    const windowed = after.payloads["rk-windowed"] as Record<string, unknown>;
    expect(windowed.mmrStart).toBe("4294967296");
    expect(windowed.mmrEnd).toBe("4294967297");
    expect(windowed.requestKey).toBe("rk-windowed");
    const windowless = after.payloads["rk-windowless"] as Record<
      string,
      unknown
    >;
    expect(windowless).toEqual({
      requestKey: "rk-windowless",
      logId: seeded.logHex32,
    });
  });

  it("is idempotent: a second boot changes nothing", async () => {
    const seeded = await seedLegacyStore();
    await expectMigratedValues(seeded);
    const first = await inspect(seeded.stub);

    await runInDurableObject(seeded.stub, async (instance) => {
      (instance as unknown as { initialized: boolean }).initialized = false;
    });
    await expectMigratedValues(seeded);
    expect(await inspect(seeded.stub)).toEqual(first);
  });

  it("creates BLOB range columns directly on a fresh database", async () => {
    const stub = env.DELEGATION_STORE.get(
      env.DELEGATION_STORE.idFromName(`range-blob-fresh-${randomUUID()}`),
    );
    const res = await stub.fetch(
      `https://do.internal/delegation?logId=${"0".repeat(32)}`,
    );
    expect(res.status).toBe(404);
    const after = await inspect(stub);
    expect(after.declared).toEqual({
      "delegation_certificates.mmr_start": "BLOB",
      "delegation_certificates.mmr_end": "BLOB",
      "pending.mmr_start": "BLOB",
      "pending.mmr_end": "BLOB",
    });
  });
});
