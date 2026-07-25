/**
 * ReceivablesDO Durable Object — what a root-log owner owes the pipe operator.
 *
 * Implements ADR-0058 (pipe-fee receivables, root-only liability). One instance
 * per **liable account**, addressed by `liableAccountKey()` — the lowercased
 * `<chainId>:<univocityAddr>` of the payment-authoritative registration. Only
 * the root-log owner is liable (§1); canopy never bills or meters individual
 * logs in a hierarchy, so there is no per-log state here.
 *
 * **Sharding: deliberately one instance per account, not sharded.** The sibling
 * `X402SettlementDO` shards by `DO_SHARD_COUNT` because settlement jobs for
 * *different* auths contend on one object. Receivables do not have that shape:
 * contention is naturally per-account, and sharding would split a single
 * account's state across objects — which is the opposite of what is wanted,
 * since every read and write here concerns exactly one account. The cost is
 * that one account's 402 reads serialise through one object; that is acceptable
 * while the read is a single indexed point lookup. Revisit with FOR-474 if a
 * large operator's request rate makes it material.
 *
 * Hosted in `x402-settlement` rather than `canopy-api` (§5): canopy-api defines
 * no Durable Object classes and has no migrations block, whereas this worker
 * already has both. canopy-api binds cross-script. The 402-path read therefore
 * costs an in-colocation RPC; whether that is material is FOR-469.
 *
 * **The accounting here is deliberately imprecise (§7).** Noticing arrears is
 * sufficient; ops reconciliation against public chain records is an acceptable
 * backstop. Do not grow this into an authoritative ledger, and do not couple
 * deactivation directly to a balance — billing and deactivation stay separate.
 *
 * See: devdocs/adr/adr-0058-pipe-fee-receivables-root-liability.md
 */

import { DurableObject } from "cloudflare:workers";
import type { Env } from "../env.js";

/** Arrears posture for an account. Deliberately coarse — see §7. */
export type ArrearsState = "current" | "suspect" | "in-arrears";

const ARREARS_STATES: readonly ArrearsState[] = [
  "current",
  "suspect",
  "in-arrears",
];

/** Identity of the account this instance is responsible for. */
export interface AccountRef {
  accountKey: string;
  chainId: string;
  univocityAddr: string;
  /** UUID of the payment-authoritative registration (the root log). */
  root: string;
}

/** What canopy knows it is owed by one root-log owner. */
export interface AccountEntitlement extends AccountRef {
  /** Metered unit: checkpoints attributed to this account (§3). */
  checkpointsAccrued: number;
  arrears: ArrearsState;
  /**
   * Size of the grant hierarchy under this root. A legitimate price input (§4)
   * because the root owner monetises everything beneath them. Incremented at
   * registration time, never computed by traversal.
   */
  subtreeRegistrations: number;
  /** Greatest observed depth below the root. */
  subtreeMaxDepth: number;
  updatedAt: number;
}

interface AccountRow extends Record<string, SqlStorageValue> {
  account_key: string;
  chain_id: string;
  univocity_addr: string;
  root: string;
  checkpoints_accrued: number;
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
        account_key TEXT PRIMARY KEY,
        chain_id TEXT NOT NULL,
        univocity_addr TEXT NOT NULL,
        root TEXT NOT NULL,
        checkpoints_accrued INTEGER NOT NULL DEFAULT 0,
        arrears TEXT NOT NULL DEFAULT 'current'
          CHECK (arrears IN ('current', 'suspect', 'in-arrears')),
        subtree_registrations INTEGER NOT NULL DEFAULT 0,
        subtree_max_depth INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL
      );

      -- Accrual is idempotent. Queue delivery is at-least-once, and because the
      -- accounting is deliberately imprecise (ADR-0058 §7) NOTHING downstream
      -- would notice a double-count — so the dedup has to be here. Mirrors
      -- X402SettlementDO's settled_jobs.
      CREATE TABLE IF NOT EXISTS accrual_events (
        idempotency_key TEXT PRIMARY KEY,
        account_key TEXT NOT NULL,
        count INTEGER NOT NULL,
        accrued_at INTEGER NOT NULL
      );
    `);
    this.initialized = true;
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
      accountKey: r.account_key,
      chainId: r.chain_id,
      univocityAddr: r.univocity_addr,
      root: r.root,
      checkpointsAccrued: r.checkpoints_accrued,
      arrears: r.arrears as ArrearsState,
      subtreeRegistrations: r.subtree_registrations,
      subtreeMaxDepth: r.subtree_max_depth,
      updatedAt: r.updated_at,
    };
  }

  /**
   * Bind this instance to one account, and refuse any other.
   *
   * There is one instance per account, so a differing key means the caller
   * routed to the wrong object. Without this the write would land as a second
   * row and read back cleanly — a silent cross-account contamination.
   */
  private bind(account: AccountRef): AccountRow {
    const existing = this.row();
    if (existing) {
      if (existing.account_key !== account.accountKey) {
        throw new Error(
          `ReceivablesDO is bound to account ${existing.account_key}; ` +
            `refusing operation for ${account.accountKey}`,
        );
      }
      return existing;
    }
    this.ctx.storage.sql.exec(
      `INSERT INTO account (account_key, chain_id, univocity_addr, root, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
      account.accountKey,
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
   * Read entitlement for the 402 path.
   *
   * Returns null for an account with no recorded activity. A caller MUST treat
   * that as "nothing owed", never as "unknown, therefore refuse" — an account
   * that has not yet accrued anything is in good standing by definition, and
   * refusing would turn every new customer's first 402 into a failure.
   */
  async getEntitlement(accountKey: string): Promise<AccountEntitlement | null> {
    this.ensureSchema();
    const r = this.row();
    if (!r) return null;
    if (r.account_key !== accountKey) {
      throw new Error(
        `ReceivablesDO is bound to account ${r.account_key}; ` +
          `refusing read for ${accountKey}`,
      );
    }
    return this.toEntitlement(r);
  }

  /**
   * Accrue metered checkpoints against an account (§3), **idempotently**.
   *
   * `idempotencyKey` must be stable for a given accrual event — replaying it
   * leaves the count unchanged. Queue delivery is at-least-once; see the
   * accrual_events comment in the schema for why the dedup must live here.
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

    this.ctx.storage.sql.exec(
      `INSERT INTO accrual_events (idempotency_key, account_key, count, accrued_at)
       VALUES (?, ?, ?, ?)`,
      idempotencyKey.trim(),
      account.accountKey,
      count,
      this.now(),
    );
    this.ctx.storage.sql.exec(
      `UPDATE account
          SET checkpoints_accrued = checkpoints_accrued + ?, updated_at = ?
        WHERE account_key = ?`,
      count,
      this.now(),
      account.accountKey,
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
   * `depth` is the walk distance from the registration to its
   * payment-authoritative ancestor, so a direct child is 1.
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
        WHERE account_key = ?`,
      depth,
      this.now(),
      account.accountKey,
    );
  }

  /**
   * Set the arrears posture.
   *
   * Separate from billing on purpose (§7): this records a *judgement* about an
   * account, which may come from ops reconciliation rather than from any
   * balance held here. Enforcement acting on it is forward-only — it freezes
   * growth and never touches committed history.
   */
  async setArrears(
    accountKey: string,
    arrears: ArrearsState,
  ): Promise<AccountEntitlement | null> {
    this.ensureSchema();
    if (!ARREARS_STATES.includes(arrears)) {
      throw new Error(`unknown arrears state: ${String(arrears)}`);
    }
    const r = this.row();
    if (!r) return null;
    if (r.account_key !== accountKey) {
      throw new Error(
        `ReceivablesDO is bound to account ${r.account_key}; ` +
          `refusing write for ${accountKey}`,
      );
    }
    this.ctx.storage.sql.exec(
      `UPDATE account SET arrears = ?, updated_at = ? WHERE account_key = ?`,
      arrears,
      this.now(),
      accountKey,
    );
    const updated = this.row();
    return updated ? this.toEntitlement(updated) : null;
  }
}
