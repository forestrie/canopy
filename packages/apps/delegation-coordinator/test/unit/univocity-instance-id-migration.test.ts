/**
 * Boot-time migration of the univocity instance identifier (plan-2607-43
 * slice 01, ADR-0059 D1/D6): the `instance_key` columns rename to
 * `univocity_instance_id` and stored legacy `{chainId}:{40hex}` values are
 * rewritten to canonical CAIP-10 `eip155:{chainId}:0x{40hex}`.
 *
 * Seeds a dedicated DO (never one of the worker's shards, whose schema other
 * tests may already have initialized) with the exact legacy schema and rows,
 * then lets the first fetch run ensureSchema.
 */

import { randomUUID } from "node:crypto";
import { env, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DelegationStoreDO } from "../../src/durableobjects/delegation-store.js";
import type { Env } from "../../src/env.js";
import { normalizeLogIdToHex32 } from "../../src/log-id.js";
import type { WebhookConfigResponse } from "../../src/types/webhook-config-response.js";
import type { InstanceWebhookResponse } from "../../src/types/instance-webhook.js";

declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}

const LEGACY_ADDR = "75be7950f26fe7f15336a10b33a8d8134fadb787";
const LEGACY_KEY = `84532:${LEGACY_ADDR}`;
const CANONICAL_ID = `eip155:84532:0x${LEGACY_ADDR}`;
const INSTANCE_URL = "https://hooks.example.test/migrated-instance";
const UNPARSEABLE_KEY = "not-a-legacy-key";

/** Create the pre-migration table shapes (legacy `instance_key` columns). */
function createLegacyTables(sql: SqlStorage): void {
  // Base table as created before this migration; instance columns arrived
  // via the legacy ALTER path, so add them the same way.
  sql.exec(`
    CREATE TABLE log_delegation_config (
      log_id_hex32 TEXT PRIMARY KEY,
      webhook_url TEXT,
      enabled INTEGER NOT NULL DEFAULT 1,
      user_enabled INTEGER NOT NULL DEFAULT 1,
      operator_enabled INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);
  sql.exec(`ALTER TABLE log_delegation_config ADD COLUMN instance_key TEXT`);
  sql.exec(`ALTER TABLE log_delegation_config ADD COLUMN webhook_source TEXT`);
  sql.exec(`
    CREATE TABLE instance_webhooks (
      instance_key TEXT PRIMARY KEY,
      webhook_url TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);
  sql.exec(`
    CREATE INDEX idx_log_delegation_config_instance
    ON log_delegation_config (instance_key)
  `);
}

/** Insert an instance_webhooks row with the legacy column name. */
function insertInstanceWebhook(
  sql: SqlStorage,
  key: string,
  url: string,
): void {
  const now = Date.now();
  sql.exec(
    `INSERT INTO instance_webhooks (instance_key, webhook_url, created_at, updated_at)
     VALUES (?, ?, ?, ?)`,
    key,
    url,
    now,
    now,
  );
}

/** Seed the pre-migration schema and legacy-format rows into a fresh DO. */
async function seedLegacyStore(
  stub: DurableObjectStub<DelegationStoreDO>,
  ids: {
    inheritedLogHex32: string;
    unparseableLogHex32: string;
  },
): Promise<void> {
  await runInDurableObject(stub, async (_instance, state) => {
    const sql = state.storage.sql;
    createLegacyTables(sql);

    const now = Date.now();
    sql.exec(
      `INSERT INTO instance_webhooks (instance_key, webhook_url, created_at, updated_at)
       VALUES (?, ?, ?, ?)`,
      LEGACY_KEY,
      INSTANCE_URL,
      now,
      now,
    );
    sql.exec(
      `INSERT INTO log_delegation_config
         (log_id_hex32, webhook_url, instance_key, webhook_source, created_at, updated_at)
       VALUES (?, ?, ?, 'instance', ?, ?)`,
      ids.inheritedLogHex32,
      INSTANCE_URL,
      LEGACY_KEY,
      now,
      now,
    );
    sql.exec(
      `INSERT INTO log_delegation_config
         (log_id_hex32, instance_key, webhook_source, created_at, updated_at)
       VALUES (?, ?, 'instance', ?, ?)`,
      ids.unparseableLogHex32,
      UNPARSEABLE_KEY,
      now,
      now,
    );
  });
}

describe("univocity instance id boot-time migration", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renames the columns, canonicalizes values, and keeps inheritance resolving", async () => {
    // Dedicated DO id so the seeded legacy schema is what ensureSchema meets.
    const id = env.DELEGATION_STORE.idFromName(
      `migration-test-${randomUUID()}`,
    );
    const stub = env.DELEGATION_STORE.get(id);
    const inheritedLogHex32 = normalizeLogIdToHex32(randomUUID());
    const unparseableLogHex32 = normalizeLogIdToHex32(randomUUID());
    await seedLegacyStore(stub, { inheritedLogHex32, unparseableLogHex32 });

    // First fetch boots the DO schema, running the migration.
    const res = await stub.fetch(
      `https://do.internal/webhook/${inheritedLogHex32}`,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as WebhookConfigResponse;
    expect(body.univocityInstanceId).toBe(CANONICAL_ID);
    // Legacy alias carried during the shim cycle (dropped in slice 05).
    expect(body.instanceKey).toBe(CANONICAL_ID);
    expect(body.webhookUrl).toBe(INSTANCE_URL);
    expect(body.inherited).toBe(true);

    // The instance replica row was rewritten too: canonical id resolves, the
    // retired legacy form no longer parses at the DO boundary.
    const instRes = await stub.fetch(
      `https://do.internal/instance-webhook/${encodeURIComponent(CANONICAL_ID)}`,
    );
    expect(instRes.status).toBe(200);
    const instBody = (await instRes.json()) as InstanceWebhookResponse;
    expect(instBody.univocityInstanceId).toBe(CANONICAL_ID);
    expect(instBody.webhookUrl).toBe(INSTANCE_URL);
    expect(instBody.memberLogs).toBe(1);
    const legacyRes = await stub.fetch(
      `https://do.internal/instance-webhook/${encodeURIComponent(LEGACY_KEY)}`,
    );
    expect(legacyRes.status).toBe(400);

    // An unconvertible stored value is kept, not dropped.
    const weirdRes = await stub.fetch(
      `https://do.internal/webhook/${unparseableLogHex32}`,
    );
    expect(weirdRes.status).toBe(200);
    const weirdBody = (await weirdRes.json()) as WebhookConfigResponse;
    expect(weirdBody.univocityInstanceId).toBe(UNPARSEABLE_KEY);

    // Inheritance by copy still resolves against the rewritten replica.
    const newLogHex32 = normalizeLogIdToHex32(randomUUID());
    const bindRes = await stub.fetch(
      `https://do.internal/webhook/${newLogHex32}`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ univocityInstanceId: CANONICAL_ID }),
      },
    );
    expect(bindRes.status).toBe(200);
    const bindBody = (await bindRes.json()) as WebhookConfigResponse;
    expect(bindBody.webhookUrl).toBe(INSTANCE_URL);
    expect(bindBody.univocityInstanceId).toBe(CANONICAL_ID);
    expect(bindBody.inherited).toBe(true);

    // Safe to run repeatedly: force ensureSchema to run again on the migrated
    // database and confirm nothing changes.
    await runInDurableObject(stub, async (instance) => {
      (instance as unknown as { initialized: boolean }).initialized = false;
    });
    const again = await stub.fetch(
      `https://do.internal/webhook/${inheritedLogHex32}`,
    );
    expect(again.status).toBe(200);
    const againBody = (await again.json()) as WebhookConfigResponse;
    expect(againBody.univocityInstanceId).toBe(CANONICAL_ID);
    expect(againBody.webhookUrl).toBe(INSTANCE_URL);
  });

  it("migrates a database that pre-dates the instance columns entirely", async () => {
    const id = env.DELEGATION_STORE.idFromName(
      `migration-test-${randomUUID()}`,
    );
    const stub = env.DELEGATION_STORE.get(id);
    const logHex32 = normalizeLogIdToHex32(randomUUID());
    await runInDurableObject(stub, async (_instance, state) => {
      const now = Date.now();
      state.storage.sql.exec(`
        CREATE TABLE log_delegation_config (
          log_id_hex32 TEXT PRIMARY KEY,
          webhook_url TEXT,
          enabled INTEGER NOT NULL DEFAULT 1,
          user_enabled INTEGER NOT NULL DEFAULT 1,
          operator_enabled INTEGER NOT NULL DEFAULT 1,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        )
      `);
      state.storage.sql.exec(
        `INSERT INTO log_delegation_config (log_id_hex32, webhook_url, created_at, updated_at)
         VALUES (?, 'https://hooks.example.test/pre-for-468', ?, ?)`,
        logHex32,
        now,
        now,
      );
    });

    const res = await stub.fetch(`https://do.internal/webhook/${logHex32}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as WebhookConfigResponse;
    expect(body.webhookUrl).toBe("https://hooks.example.test/pre-for-468");
    expect(body.univocityInstanceId).toBeUndefined();
  });

  // The hazardous version-skew state (plan-2607-02 R2): the new canopy-api's
  // deploy-window shim writes a canonical-keyed row while the old coordinator
  // stored a legacy-keyed twin for the same instance. The rewrite must keep
  // the canonical row (strictly newer — old code never generated canonical
  // values) and never throw out of boot.
  it("resolves a legacy/canonical instance_webhooks twin by keeping the canonical row", async () => {
    const id = env.DELEGATION_STORE.idFromName(
      `migration-test-${randomUUID()}`,
    );
    const stub = env.DELEGATION_STORE.get(id);
    const legacyUrl = "https://hooks.example.test/pre-cutover";
    const canonicalUrl = "https://hooks.example.test/post-cutover";
    await runInDurableObject(stub, async (_instance, state) => {
      createLegacyTables(state.storage.sql);
      insertInstanceWebhook(state.storage.sql, LEGACY_KEY, legacyUrl);
      insertInstanceWebhook(state.storage.sql, CANONICAL_ID, canonicalUrl);
    });

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const res = await stub.fetch(
      `https://do.internal/instance-webhook/${encodeURIComponent(CANONICAL_ID)}`,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as InstanceWebhookResponse;
    // The canonical row's URL survives; the legacy row was deleted, not
    // rewritten over the canonical one.
    expect(body.webhookUrl).toBe(canonicalUrl);
    expect(
      warn.mock.calls.some(([msg]) => String(msg).includes("collides")),
    ).toBe(true);
  });

  it("converts the third format eip155:{chainId}:{40hex} without 0x", async () => {
    const id = env.DELEGATION_STORE.idFromName(
      `migration-test-${randomUUID()}`,
    );
    const stub = env.DELEGATION_STORE.get(id);
    // Mixed case exercises the lowercasing on top of the 0x repair.
    const thirdFormKey = `eip155:84532:${LEGACY_ADDR.toUpperCase()}`;
    await runInDurableObject(stub, async (_instance, state) => {
      createLegacyTables(state.storage.sql);
      insertInstanceWebhook(state.storage.sql, thirdFormKey, INSTANCE_URL);
    });

    const res = await stub.fetch(
      `https://do.internal/instance-webhook/${encodeURIComponent(CANONICAL_ID)}`,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as InstanceWebhookResponse;
    expect(body.univocityInstanceId).toBe(CANONICAL_ID);
    expect(body.webhookUrl).toBe(INSTANCE_URL);
  });

  // Non-fatal rule (plan-2607-02 R2): whatever shape a value has, boot warns
  // and continues — a data problem must never become a constructor crash loop.
  it("never throws out of boot when fuzzed with malformed values", async () => {
    const id = env.DELEGATION_STORE.idFromName(
      `migration-test-${randomUUID()}`,
    );
    const stub = env.DELEGATION_STORE.get(id);
    const junkKeys = [
      "not-an-id!",
      "eip155:",
      "eip155:0:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "84532:not-forty-hex",
      ":::",
      `eip155:84532:0x${"g".repeat(40)}`,
      `084532:${LEGACY_ADDR}`,
    ];
    const junkLogHex32 = normalizeLogIdToHex32(randomUUID());
    await runInDurableObject(stub, async (_instance, state) => {
      const sql = state.storage.sql;
      createLegacyTables(sql);
      for (const key of junkKeys) {
        insertInstanceWebhook(sql, key, INSTANCE_URL);
      }
      const now = Date.now();
      sql.exec(
        `INSERT INTO log_delegation_config
           (log_id_hex32, instance_key, webhook_source, created_at, updated_at)
         VALUES (?, ?, 'instance', ?, ?)`,
        junkLogHex32,
        junkKeys[0],
        now,
        now,
      );
    });

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const res = await stub.fetch(`https://do.internal/webhook/${junkLogHex32}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as WebhookConfigResponse;
    // Junk is kept, warned about, and never dropped.
    expect(body.univocityInstanceId).toBe(junkKeys[0]);
    expect(
      warn.mock.calls.some(([msg]) =>
        String(msg).includes("neither canonical nor legacy"),
      ),
    ).toBe(true);
  });
});
