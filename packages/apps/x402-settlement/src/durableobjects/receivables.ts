/**
 * ReceivablesDO Durable Object — what a root-log owner owes the pipe operator.
 *
 * Implements ADR-0058 (pipe-fee receivables, root-only liability) as amended
 * by ADR-0059: one instance per account, and the account IS the univocity
 * instance — addressed by `idFromName(univocityInstanceId)`, the canonical
 * CAIP-10 id (plan-2607-43 D1/D6/D7). The account holds **prepaid checkpoint
 * credits** (ADR-0059 decision 8): the indexer decrements per anchored
 * checkpoint, payments (slice 04) credit, and `credit_floor` doubles as a
 * credit line for vetted accounts.
 *
 * **Sharding: deliberately one instance per account, not sharded.** The sibling
 * `X402SettlementDO` shards by `DO_SHARD_COUNT` because settlement jobs for
 * *different* auths contend on one object. Receivables do not have that shape:
 * contention is naturally per-account, and sharding would split a single
 * account's state across objects — which is the opposite of what is wanted,
 * since every read and write here concerns exactly one account. The cost is
 * that one account's reads serialise through one object; that is acceptable
 * while the read is a single indexed point lookup. Revisit with FOR-474 if a
 * large operator's request rate makes it material.
 *
 * Hosted in `x402-settlement` rather than `canopy-api` (§5). Per ADR-0059
 * decision 6 / plan-2607-02 D4 there is **no** canopy-api binding: the data
 * plane never reads entitlement, and enforcement is the kill switch, flipped
 * by the indexer only once `ENFORCEMENT_ARMED` is true (slice 04).
 *
 * **The accounting here is deliberately imprecise (§7).** Noticing arrears is
 * sufficient; ops reconciliation against public chain records is an acceptable
 * backstop. Do not grow this into an authoritative ledger, and do not couple
 * deactivation directly to a balance — billing and deactivation stay separate.
 *
 * **This RPC surface is the stable ingestion contract** for any event source
 * (slice-03 build-vs-buy decision): the native cron indexer today, a
 * purpose-built indexer later — both write through the same idempotent
 * methods, keyed `{txHash}:{logIndex}`, so swapping sources cannot
 * double-count.
 *
 * See: devdocs/adr/adr-0058-pipe-fee-receivables-root-liability.md,
 * devdocs/adr/adr-0059-instance-root-fee-accounts.md.
 */

import { DurableObject } from "cloudflare:workers";
import type { Env } from "../env.js";

/** Arrears posture for an account. Deliberately coarse — see §7. */
export type ArrearsState = "current" | "suspect" | "in-arrears";

/**
 * How long a spent idempotency key is retained.
 *
 * The dedup only has to outlive the window in which an event can be
 * *redelivered* — for the indexer that is the watermark lag, hours at most —
 * so the table is bounded rather than growing for the life of the account.
 */
const ACCRUAL_KEY_RETENTION_SECONDS = 7 * 24 * 60 * 60;

const ARREARS_STATES: readonly ArrearsState[] = [
  "current",
  "suspect",
  "in-arrears",
];

/** Identity of the account this instance is responsible for. */
export interface AccountRef {
  /** Canonical CAIP-10 univocity instance id — also the DO name. */
  univocityInstanceId: string;
  chainId: string;
  univocityAddr: string;
  /** UUID of the root-log registration — the kill-switch key (slice 04). */
  root: string;
}

/** One anchored checkpoint observed on-chain (source-agnostic). */
export interface CheckpointAccrualEvent {
  /** Stable per-event key: `{txHash}:{logIndex}`. */
  idempotencyKey: string;
  /** Authority (1) vs data (2) log, from the event; recorded for tiering. */
  logKind: number;
  /** Post-checkpoint MMR leaf count, from the event; recorded for tiering. */
  size: number;
}

/** What canopy knows it is owed by one root-log owner. */
export interface AccountEntitlement extends AccountRef {
  /** Metered unit: checkpoints attributed to this account (§3). */
  checkpointsAccrued: number;
  /** Prepaid checkpoint credits remaining (may run negative pre-arming). */
  creditsBalance: number;
  /** Freeze threshold; below zero acts as a credit line (ADR-0059 D3). */
  creditFloor: number;
  arrears: ArrearsState;
  /**
   * Size of the grant hierarchy under this root. A legitimate price input (§4)
   * because the root owner monetises everything beneath them. Dormant since
   * slice 02 — the intra-instance tree is derivable from LogRegistered events.
   */
  subtreeRegistrations: number;
  /** Greatest observed depth below the root. */
  subtreeMaxDepth: number;
  updatedAt: number;
}

interface AccountRow extends Record<string, SqlStorageValue> {
  univocity_instance_id: string;
  chain_id: string;
  univocity_addr: string;
  root: string;
  checkpoints_accrued: number;
  credits_balance: number;
  credit_floor: number;
  arrears: string;
  subtree_registrations: number;
  subtree_max_depth: number;
  updated_at: number;
}

export class ReceivablesDO extends DurableObject<Env> {
  private initialized = false;

  private ensureSchema(): void {
    if (this.initialized) return;

    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS account (
        univocity_instance_id TEXT PRIMARY KEY,
        chain_id TEXT NOT NULL,
        univocity_addr TEXT NOT NULL,
        root TEXT NOT NULL,
        checkpoints_accrued INTEGER NOT NULL DEFAULT 0,
        credits_balance INTEGER NOT NULL DEFAULT 0,
        credit_floor INTEGER NOT NULL DEFAULT 0,
        arrears TEXT NOT NULL DEFAULT 'current'
          CHECK (arrears IN ('current', 'suspect', 'in-arrears')),
        subtree_registrations INTEGER NOT NULL DEFAULT 0,
        subtree_max_depth INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL
      );

      -- Accrual is idempotent. Event delivery is at-least-once whatever the
      -- source (queue redelivery, indexer rescan), and because the accounting
      -- is deliberately imprecise (ADR-0058 §7) NOTHING downstream would
      -- notice a double-count — so the dedup has to be here.
      CREATE TABLE IF NOT EXISTS accrual_events (
        idempotency_key TEXT PRIMARY KEY,
        univocity_instance_id TEXT NOT NULL,
        count INTEGER NOT NULL,
        log_kind INTEGER,
        size INTEGER,
        accrued_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_accrual_events_accrued_at
        ON accrual_events (accrued_at);

      -- Credits purchases (slice 04 writes; schema lands with v3 so the shape
      -- is settled before any caller exists).
      CREATE TABLE IF NOT EXISTS payment_events (
        idempotency_key TEXT PRIMARY KEY,
        univocity_instance_id TEXT NOT NULL,
        credits INTEGER NOT NULL,
        tx_hash TEXT,
        paid_at INTEGER NOT NULL
      );

      -- Source-owned cursor for the chain-event indexer. Keyed by the chain
      -- binding rather than assumed singular so a future source can cursor
      -- per-chain without a schema change.
      CREATE TABLE IF NOT EXISTS watermarks (
        chain_id TEXT NOT NULL,
        univocity_addr TEXT NOT NULL,
        last_block INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (chain_id, univocity_addr)
      );
    `);

    this.ensureV3Columns();
    this.initialized = true;
  }

  /**
   * Legacy-table upgrades (pre-v3 local dev state only — the store shipped
   * with no deployed binding, so lane data is born v3). Probe-then-ALTER per
   * the DDL-vs-DML migration rules in docs/agents/gotchas.md; renames and
   * ADD COLUMN only, no data rewrites, so constructor-fatal is acceptable.
   */
  private ensureV3Columns(): void {
    const sql = this.ctx.storage.sql;
    const hasColumn = (table: string, column: string): boolean => {
      try {
        [...sql.exec(`SELECT ${column} FROM ${table} LIMIT 0`)];
        return true;
      } catch {
        return false;
      }
    };

    for (const table of ["account", "accrual_events"]) {
      if (
        !hasColumn(table, "univocity_instance_id") &&
        hasColumn(table, "account_key")
      ) {
        sql.exec(
          `ALTER TABLE ${table} RENAME COLUMN account_key TO univocity_instance_id`,
        );
      }
    }
    for (const [table, column, ddl] of [
      ["account", "credits_balance", "INTEGER NOT NULL DEFAULT 0"],
      ["account", "credit_floor", "INTEGER NOT NULL DEFAULT 0"],
      ["accrual_events", "log_kind", "INTEGER"],
      ["accrual_events", "size", "INTEGER"],
    ] as const) {
      if (!hasColumn(table, column)) {
        sql.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
      }
    }
  }

  private now(): number {
    return Math.floor(Date.now() / 1000);
  }

  private row(): AccountRow | null {
    const rows = this.ctx.storage.sql
      .exec<AccountRow>(`SELECT * FROM account LIMIT 1`)
      .toArray();
    return rows[0] ?? null;
  }

  private toEntitlement(r: AccountRow): AccountEntitlement {
    return {
      univocityInstanceId: r.univocity_instance_id,
      chainId: r.chain_id,
      univocityAddr: r.univocity_addr,
      root: r.root,
      checkpointsAccrued: r.checkpoints_accrued,
      creditsBalance: r.credits_balance,
      creditFloor: r.credit_floor,
      arrears: r.arrears as ArrearsState,
      subtreeRegistrations: r.subtree_registrations,
      subtreeMaxDepth: r.subtree_max_depth,
      updatedAt: r.updated_at,
    };
  }

  /**
   * Bind this instance to one account, and refuse any other.
   *
   * There is one instance per account, so a differing id means the caller
   * routed to the wrong object. Without this the write would land as a second
   * row and read back cleanly — a silent cross-account contamination.
   */
  private bind(account: AccountRef): AccountRow {
    const existing = this.row();
    if (existing) {
      if (existing.univocity_instance_id !== account.univocityInstanceId) {
        throw new Error(
          `ReceivablesDO is bound to account ${existing.univocity_instance_id}; ` +
            `refusing operation for ${account.univocityInstanceId}`,
        );
      }
      return existing;
    }
    this.ctx.storage.sql.exec(
      `INSERT INTO account (univocity_instance_id, chain_id, univocity_addr, root, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
      account.univocityInstanceId,
      account.chainId,
      account.univocityAddr,
      account.root,
      this.now(),
    );
    const created = this.row();
    if (!created) {
      throw new Error(
        "ReceivablesDO: account row missing immediately after insert",
      );
    }
    return created;
  }

  /**
   * Arrears derived from the prepaid balance (ADR-0059 D3), stored so the
   * status read and the (slice-04) arming check share one truth. A manual
   * `setArrears` judgement holds only until the next applied batch — ops
   * overrides are for between-cycle correction, not a parallel state machine.
   */
  private derivedArrears(r: AccountRow): ArrearsState {
    return r.credits_balance < r.credit_floor ? "in-arrears" : "current";
  }

  /**
   * Read entitlement for the ops status route (and, later, arming).
   *
   * Returns null for an account with no recorded activity. A caller MUST treat
   * that as "nothing owed", never as "unknown, therefore refuse" — an account
   * that has not yet accrued anything is in good standing by definition.
   */
  async getEntitlement(
    univocityInstanceId: string,
  ): Promise<AccountEntitlement | null> {
    this.ensureSchema();
    const r = this.row();
    if (!r) return null;
    if (r.univocity_instance_id !== univocityInstanceId) {
      throw new Error(
        `ReceivablesDO is bound to account ${r.univocity_instance_id}; ` +
          `refusing read for ${univocityInstanceId}`,
      );
    }
    return this.toEntitlement(r);
  }

  /**
   * Indexer read: entitlement plus the source-owned watermark, one hop.
   */
  async getIndexState(univocityInstanceId: string): Promise<{
    entitlement: AccountEntitlement | null;
    lastBlock: number | null;
  }> {
    this.ensureSchema();
    const r = this.row();
    if (r && r.univocity_instance_id !== univocityInstanceId) {
      throw new Error(
        `ReceivablesDO is bound to account ${r.univocity_instance_id}; ` +
          `refusing read for ${univocityInstanceId}`,
      );
    }
    const wm = this.ctx.storage.sql
      .exec<{
        last_block: number;
      }>(`SELECT last_block FROM watermarks LIMIT 1`)
      .toArray()[0];
    return {
      entitlement: r ? this.toEntitlement(r) : null,
      lastBlock: wm?.last_block ?? null,
    };
  }

  /**
   * Apply one scanned range: idempotent per-event accrual plus the watermark
   * advance, atomically within this object. New events decrement the prepaid
   * balance and increment the checkpoint count; replayed events are no-ops.
   * The watermark only moves forward (a re-run of an old range cannot rewind
   * it), and it advances even when the range held no events — that is what
   * makes an empty chain scan progress.
   */
  async applyCheckpointEvents(
    account: AccountRef,
    events: CheckpointAccrualEvent[],
    lastBlockScanned: number,
  ): Promise<AccountEntitlement> {
    this.ensureSchema();
    if (!Number.isInteger(lastBlockScanned) || lastBlockScanned < 0) {
      throw new Error(
        `applyCheckpointEvents requires a non-negative integer lastBlockScanned, got ${lastBlockScanned}`,
      );
    }
    this.bind(account);

    let applied = 0;
    for (const event of events) {
      const key = event.idempotencyKey?.trim();
      if (!key) {
        throw new Error(
          "applyCheckpointEvents requires a non-empty idempotencyKey per event",
        );
      }
      const seen = this.ctx.storage.sql
        .exec<{
          n: number;
        }>(
          `SELECT COUNT(*) AS n FROM accrual_events WHERE idempotency_key = ?`,
          key,
        )
        .toArray()[0];
      if (seen && seen.n > 0) continue;
      this.ctx.storage.sql.exec(
        `INSERT INTO accrual_events (idempotency_key, univocity_instance_id, count, log_kind, size, accrued_at)
         VALUES (?, ?, 1, ?, ?, ?)`,
        key,
        account.univocityInstanceId,
        event.logKind,
        event.size,
        this.now(),
      );
      applied += 1;
    }

    if (applied > 0) {
      this.ctx.storage.sql.exec(
        `DELETE FROM accrual_events WHERE accrued_at < ?`,
        this.now() - ACCRUAL_KEY_RETENTION_SECONDS,
      );
      this.ctx.storage.sql.exec(
        `UPDATE account
            SET checkpoints_accrued = checkpoints_accrued + ?,
                credits_balance = credits_balance - ?,
                updated_at = ?
          WHERE univocity_instance_id = ?`,
        applied,
        applied,
        this.now(),
        account.univocityInstanceId,
      );
    }

    this.ctx.storage.sql.exec(
      `INSERT INTO watermarks (chain_id, univocity_addr, last_block, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT (chain_id, univocity_addr)
       DO UPDATE SET last_block = MAX(last_block, excluded.last_block),
                     updated_at = excluded.updated_at`,
      account.chainId,
      account.univocityAddr,
      lastBlockScanned,
      this.now(),
    );

    const current = this.row();
    if (!current) {
      throw new Error("ReceivablesDO: account row missing after batch apply");
    }
    const arrears = this.derivedArrears(current);
    if (arrears !== current.arrears) {
      this.ctx.storage.sql.exec(
        `UPDATE account SET arrears = ?, updated_at = ? WHERE univocity_instance_id = ?`,
        arrears,
        this.now(),
        account.univocityInstanceId,
      );
    }
    const updated = this.row();
    if (!updated) {
      throw new Error("ReceivablesDO: account row missing after batch apply");
    }
    return this.toEntitlement(updated);
  }

  /**
   * Accrue metered checkpoints against an account (§3), **idempotently**.
   *
   * The single-event form of the ingestion contract; sources with batch and
   * watermark semantics use {@link applyCheckpointEvents}.
   */
  async accrueCheckpoints(
    account: AccountRef,
    idempotencyKey: string,
    count = 1,
  ): Promise<AccountEntitlement> {
    this.ensureSchema();
    if (!idempotencyKey?.trim()) {
      throw new Error("accrueCheckpoints requires a non-empty idempotencyKey");
    }
    if (!Number.isInteger(count) || count < 1) {
      throw new Error(
        `accrueCheckpoints requires a positive integer count, got ${count}`,
      );
    }
    const current = this.bind(account);

    const seen = this.ctx.storage.sql
      .exec<{
        n: number;
      }>(
        `SELECT COUNT(*) AS n FROM accrual_events WHERE idempotency_key = ?`,
        idempotencyKey.trim(),
      )
      .toArray()[0];
    if (seen && seen.n > 0) {
      // Already applied. Return current state unchanged.
      return this.toEntitlement(current);
    }

    // Bound the dedup table. Opportunistic on write: no alarm to schedule and
    // no unbounded growth, at the cost of a cheap DELETE per accrual.
    this.ctx.storage.sql.exec(
      `DELETE FROM accrual_events WHERE accrued_at < ?`,
      this.now() - ACCRUAL_KEY_RETENTION_SECONDS,
    );
    this.ctx.storage.sql.exec(
      `INSERT INTO accrual_events (idempotency_key, univocity_instance_id, count, accrued_at)
       VALUES (?, ?, ?, ?)`,
      idempotencyKey.trim(),
      account.univocityInstanceId,
      count,
      this.now(),
    );
    this.ctx.storage.sql.exec(
      `UPDATE account
          SET checkpoints_accrued = checkpoints_accrued + ?,
              credits_balance = credits_balance - ?,
              updated_at = ?
        WHERE univocity_instance_id = ?`,
      count,
      count,
      this.now(),
      account.univocityInstanceId,
    );
    const updated = this.row();
    if (!updated) {
      throw new Error("ReceivablesDO: account row missing after accrual");
    }
    return this.toEntitlement(updated);
  }

  /**
   * Record a registration beneath this root, for depth-based pricing (§4).
   *
   * Dormant since plan-2607-43 slice 02 — the intra-instance tree is
   * derivable from `LogRegistered` events — retained for a possible
   * event-derived refresh.
   */
  async noteRegistration(account: AccountRef, depth: number): Promise<void> {
    this.ensureSchema();
    if (!Number.isInteger(depth) || depth < 1) {
      throw new Error(
        `noteRegistration requires a positive integer depth, got ${depth}`,
      );
    }
    this.bind(account);
    this.ctx.storage.sql.exec(
      `UPDATE account
          SET subtree_registrations = subtree_registrations + 1,
              subtree_max_depth = MAX(subtree_max_depth, ?),
              updated_at = ?
        WHERE univocity_instance_id = ?`,
      depth,
      this.now(),
      account.univocityInstanceId,
    );
  }

  /**
   * Set the arrears posture manually.
   *
   * Separate from billing on purpose (§7): this records a *judgement* about an
   * account, which may come from ops reconciliation rather than from any
   * balance held here. It holds until the next applied batch recomputes the
   * balance-derived posture. Enforcement acting on it is forward-only.
   */
  async setArrears(
    univocityInstanceId: string,
    arrears: ArrearsState,
  ): Promise<AccountEntitlement | null> {
    this.ensureSchema();
    if (!ARREARS_STATES.includes(arrears)) {
      throw new Error(`unknown arrears state: ${String(arrears)}`);
    }
    const r = this.row();
    if (!r) return null;
    if (r.univocity_instance_id !== univocityInstanceId) {
      throw new Error(
        `ReceivablesDO is bound to account ${r.univocity_instance_id}; ` +
          `refusing write for ${univocityInstanceId}`,
      );
    }
    this.ctx.storage.sql.exec(
      `UPDATE account SET arrears = ?, updated_at = ? WHERE univocity_instance_id = ?`,
      arrears,
      this.now(),
      univocityInstanceId,
    );
    const updated = this.row();
    return updated ? this.toEntitlement(updated) : null;
  }
}
