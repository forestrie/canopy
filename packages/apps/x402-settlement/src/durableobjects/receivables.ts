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
 *
 * LOAD-BEARING COUPLING: this bound is safe only because watermarks are
 * monotonic — no source ever rescans a range older than its watermark. Any
 * future ops watermark-REWIND tool (the slice-04 arming gate is a
 * watermark-SET tool for stalled accounts, which only moves forward past a
 * poisoned range) turns this retention window into a re-count window; extend
 * or suspend the GC before building one.
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
   * True when the *indexer* froze this account's root log (slice 04 arming).
   * The kill switch is one shared operator bit; this marker is what lets the
   * indexer unfreeze on recovery without ever overriding a manual ops freeze
   * it did not perform.
   */
  enforcementFrozen: boolean;
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
  enforcement_frozen: number;
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
        enforcement_frozen INTEGER NOT NULL DEFAULT 0,
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
      // v4 (slice 04): indexer-owned freeze marker.
      ["account", "enforcement_frozen", "INTEGER NOT NULL DEFAULT 0"],
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
      enforcementFrozen: r.enforcement_frozen !== 0,
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
   * The one accrual core (plan-2607-03 R6): dedup, event insert, balance and
   * count update, retention GC. Both the single-event and the batch entry
   * points delegate here so the idempotency logic cannot drift into a
   * double-count.
   *
   * @returns total count newly applied (0 when everything was a replay).
   */
  private applyAccrualCore(
    account: AccountRef,
    events: Array<{
      idempotencyKey: string;
      count: number;
      logKind?: number;
      size?: number;
    }>,
  ): number {
    let applied = 0;
    for (const event of events) {
      const key = event.idempotencyKey?.trim();
      if (!key) {
        throw new Error("accrual requires a non-empty idempotencyKey");
      }
      if (!Number.isInteger(event.count) || event.count < 1) {
        throw new Error(
          `accrual requires a positive integer count, got ${event.count}`,
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
         VALUES (?, ?, ?, ?, ?, ?)`,
        key,
        account.univocityInstanceId,
        event.count,
        event.logKind ?? null,
        event.size ?? null,
        this.now(),
      );
      applied += event.count;
    }
    if (applied > 0) {
      // Bound the dedup table. Opportunistic on write: no alarm to schedule
      // and no unbounded growth, at the cost of a cheap DELETE per accrual.
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
      this.recomputeArrears(account.univocityInstanceId);
    }
    return applied;
  }

  /** Re-derive the stored arrears posture after any balance change. */
  private recomputeArrears(univocityInstanceId: string): void {
    const current = this.row();
    if (current && this.derivedArrears(current) !== current.arrears) {
      this.ctx.storage.sql.exec(
        `UPDATE account SET arrears = ?, updated_at = ? WHERE univocity_instance_id = ?`,
        this.derivedArrears(current),
        this.now(),
        univocityInstanceId,
      );
    }
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
    // Keyed even though one binding per DO holds today: the schema invites
    // per-chain cursors later, and an unkeyed LIMIT 1 would then return an
    // arbitrary row (plan-2607-03 B4).
    const wm = r
      ? this.ctx.storage.sql
          .exec<{ last_block: number }>(
            `SELECT last_block FROM watermarks
              WHERE chain_id = ? AND univocity_addr = ?`,
            r.chain_id,
            r.univocity_addr,
          )
          .toArray()[0]
      : undefined;
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

    this.applyAccrualCore(
      account,
      events.map((event) => ({
        idempotencyKey: event.idempotencyKey,
        count: 1,
        logKind: event.logKind,
        size: event.size,
      })),
    );

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
    this.bind(account);

    this.applyAccrualCore(account, [{ idempotencyKey, count }]);

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

  /**
   * Credit a settled purchase to the account (slice 04), **idempotently** on
   * the job's idempotency key. Balance goes up, arrears recomputes — an
   * account that tops up above its floor becomes `current` on this write, and
   * the armed indexer unfreezes it on the next sweep.
   *
   * `payment_events` is NEVER garbage-collected: unlike accrual dedup keys
   * (bounded by watermark monotonicity), payment rows are the financial
   * record backing the per-cycle statement of account (plan-2607-03 E4 —
   * retention/cycling is deliberate slice-05+ work, not a GC bound here).
   */
  async recordPayment(
    account: AccountRef,
    idempotencyKey: string,
    credits: number,
    txHash?: string | null,
  ): Promise<AccountEntitlement> {
    this.ensureSchema();
    const key = idempotencyKey?.trim();
    if (!key) {
      throw new Error("recordPayment requires a non-empty idempotencyKey");
    }
    if (!Number.isInteger(credits) || credits < 1) {
      throw new Error(
        `recordPayment requires a positive integer credits, got ${credits}`,
      );
    }
    this.bind(account);

    const seen = this.ctx.storage.sql
      .exec<{
        n: number;
      }>(
        `SELECT COUNT(*) AS n FROM payment_events WHERE idempotency_key = ?`,
        key,
      )
      .toArray()[0];
    if (!seen || seen.n === 0) {
      this.ctx.storage.sql.exec(
        `INSERT INTO payment_events (idempotency_key, univocity_instance_id, credits, tx_hash, paid_at)
         VALUES (?, ?, ?, ?, ?)`,
        key,
        account.univocityInstanceId,
        credits,
        txHash ?? null,
        this.now(),
      );
      this.ctx.storage.sql.exec(
        `UPDATE account
            SET credits_balance = credits_balance + ?,
                updated_at = ?
          WHERE univocity_instance_id = ?`,
        credits,
        this.now(),
        account.univocityInstanceId,
      );
      this.recomputeArrears(account.univocityInstanceId);
    }
    const updated = this.row();
    if (!updated) {
      throw new Error("ReceivablesDO: account row missing after payment");
    }
    return this.toEntitlement(updated);
  }

  /**
   * Record whether the *indexer* holds the freeze on this account's root log.
   * Set true only after a successful arm (kill-switch off), false only after
   * a successful unfreeze — so the marker tracks actions actually taken, and
   * a manual ops freeze (marker false) is never undone by recovery.
   */
  async setEnforcementFrozen(
    univocityInstanceId: string,
    frozen: boolean,
  ): Promise<AccountEntitlement | null> {
    this.ensureSchema();
    const r = this.row();
    if (!r) return null;
    if (r.univocity_instance_id !== univocityInstanceId) {
      throw new Error(
        `ReceivablesDO is bound to account ${r.univocity_instance_id}; ` +
          `refusing write for ${univocityInstanceId}`,
      );
    }
    this.ctx.storage.sql.exec(
      `UPDATE account SET enforcement_frozen = ?, updated_at = ? WHERE univocity_instance_id = ?`,
      frozen ? 1 : 0,
      this.now(),
      univocityInstanceId,
    );
    const updated = this.row();
    return updated ? this.toEntitlement(updated) : null;
  }

  /**
   * Ops watermark-set tool (plan-2607-03 R2 residual; the recorded arming
   * gate): move a stalled account's cursor **forward** past a poisoned range
   * without a deploy. Strictly forward-only — rewinding would turn the
   * accrual dedup retention window into a double-count window (see
   * {@link ACCRUAL_KEY_RETENTION_SECONDS}); events skipped by a forward set
   * are the ADR-0058 §7 reconciliation trade, made deliberately by ops.
   */
  async setWatermark(
    univocityInstanceId: string,
    chainId: string,
    univocityAddr: string,
    lastBlock: number,
  ): Promise<{ lastBlock: number }> {
    this.ensureSchema();
    if (!Number.isInteger(lastBlock) || lastBlock < 0) {
      throw new Error(
        `setWatermark requires a non-negative integer lastBlock, got ${lastBlock}`,
      );
    }
    const r = this.row();
    if (!r) {
      throw new Error("setWatermark: no account bound to this instance");
    }
    if (r.univocity_instance_id !== univocityInstanceId) {
      throw new Error(
        `ReceivablesDO is bound to account ${r.univocity_instance_id}; ` +
          `refusing write for ${univocityInstanceId}`,
      );
    }
    const current = this.ctx.storage.sql
      .exec<{
        last_block: number;
      }>(
        `SELECT last_block FROM watermarks WHERE chain_id = ? AND univocity_addr = ?`,
        chainId,
        univocityAddr,
      )
      .toArray()[0];
    if (current && lastBlock < current.last_block) {
      throw new Error(
        `setWatermark is forward-only: requested ${lastBlock} < current ${current.last_block}`,
      );
    }
    this.ctx.storage.sql.exec(
      `INSERT INTO watermarks (chain_id, univocity_addr, last_block, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT (chain_id, univocity_addr)
       DO UPDATE SET last_block = excluded.last_block,
                     updated_at = excluded.updated_at`,
      chainId,
      univocityAddr,
      lastBlock,
      this.now(),
    );
    return { lastBlock };
  }
}
