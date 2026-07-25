/**
 * ReceivablesDO Durable Object — what a root-log owner owes the pipe operator.
 *
 * Implements ADR-0058 (pipe-fee receivables, root-only liability). One instance
 * per **liable account**, addressed by `liableAccountKey()` — the lowercased
 * CAIP-2-shaped `<chainId>:<univocityAddr>` of the payment-authoritative
 * registration. Only the root-log owner is liable (§1); canopy never bills or
 * meters individual logs in a hierarchy, so there is no per-log state here.
 *
 * Hosted in `x402-settlement` rather than `canopy-api` (§5): canopy-api defines
 * no Durable Object classes and has no migrations block, whereas this worker
 * already has both. canopy-api binds cross-script, mirroring
 * `X402_SETTLEMENT_DO`. The 402-path read therefore costs an in-colocation RPC;
 * whether that is material is FOR-469.
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

/** What canopy knows it is owed by one root-log owner. */
export interface AccountEntitlement {
  accountKey: string;
  chainId: string;
  univocityAddr: string;
  /** UUID of the payment-authoritative registration (the root log). */
  root: string;
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
        arrears TEXT NOT NULL DEFAULT 'current',
        subtree_registrations INTEGER NOT NULL DEFAULT 0,
        subtree_max_depth INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL
      );
    `);
    this.initialized = true;
  }

  private row(accountKey: string): AccountEntitlement | null {
    const rows = this.ctx.storage.sql
      .exec<{
        account_key: string;
        chain_id: string;
        univocity_addr: string;
        root: string;
        checkpoints_accrued: number;
        arrears: string;
        subtree_registrations: number;
        subtree_max_depth: number;
        updated_at: number;
      }>(`SELECT * FROM account WHERE account_key = ?`, accountKey)
      .toArray();
    const r = rows[0];
    if (!r) return null;
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
   * Read entitlement for the 402 path.
   *
   * Returns null for an account with no recorded activity. A caller MUST treat
   * that as "nothing owed", never as "unknown, therefore refuse" — an account
   * that has not yet accrued anything is in good standing by definition.
   */
  async getEntitlement(accountKey: string): Promise<AccountEntitlement | null> {
    this.ensureSchema();
    return this.row(accountKey);
  }

  /** Ensure a row exists, so accrual and registration counting can be blind. */
  private upsert(
    accountKey: string,
    chainId: string,
    univocityAddr: string,
    root: string,
  ): void {
    this.ctx.storage.sql.exec(
      `INSERT INTO account
         (account_key, chain_id, univocity_addr, root, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(account_key) DO NOTHING`,
      accountKey,
      chainId,
      univocityAddr,
      root,
      Math.floor(Date.now() / 1000),
    );
  }

  /** Accrue metered checkpoints against an account (§3). */
  async accrueCheckpoints(
    account: { accountKey: string; chainId: string; univocityAddr: string; root: string },
    count = 1,
  ): Promise<AccountEntitlement> {
    this.ensureSchema();
    this.upsert(
      account.accountKey,
      account.chainId,
      account.univocityAddr,
      account.root,
    );
    this.ctx.storage.sql.exec(
      `UPDATE account
          SET checkpoints_accrued = checkpoints_accrued + ?,
              updated_at = ?
        WHERE account_key = ?`,
      count,
      Math.floor(Date.now() / 1000),
      account.accountKey,
    );
    return this.row(account.accountKey)!;
  }

  /**
   * Record a registration beneath this root, for depth-based pricing (§4).
   *
   * `depth` is the walk distance from the registration to its
   * payment-authoritative ancestor, so a direct child is 1.
   */
  async noteRegistration(
    account: { accountKey: string; chainId: string; univocityAddr: string; root: string },
    depth: number,
  ): Promise<void> {
    this.ensureSchema();
    this.upsert(
      account.accountKey,
      account.chainId,
      account.univocityAddr,
      account.root,
    );
    this.ctx.storage.sql.exec(
      `UPDATE account
          SET subtree_registrations = subtree_registrations + 1,
              subtree_max_depth = MAX(subtree_max_depth, ?),
              updated_at = ?
        WHERE account_key = ?`,
      depth,
      Math.floor(Date.now() / 1000),
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
    this.ctx.storage.sql.exec(
      `UPDATE account SET arrears = ?, updated_at = ? WHERE account_key = ?`,
      arrears,
      Math.floor(Date.now() / 1000),
      accountKey,
    );
    return this.row(accountKey);
  }
}
