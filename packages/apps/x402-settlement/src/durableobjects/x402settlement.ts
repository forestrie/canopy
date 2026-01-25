/**
 * X402SettlementDO Durable Object
 *
 * Handles x402 settlement jobs with idempotency tracking and auth state
 * management. Each DO instance handles a shard of settlement jobs, partitioned
 * by authId for locality of auth state.
 *
 * See: devdocs/arc/arc-0015-x402-settlement-architecture.md
 */

import { DurableObject } from "cloudflare:workers";
import type {
  SettlementJob,
  SettlementResult,
  AuthState,
} from "@canopy/x402-settlement-types";
import type { Env } from "../env.js";
import { settleCharge, type SettleResponse } from "../facilitator/client.js";

/** Maximum consecutive failures before marking auth as suspect */
const SUSPECT_THRESHOLD = 3;

/** Maximum consecutive failures before marking auth as blocked */
const BLOCKED_THRESHOLD = 10;

/**
 * X402SettlementDO Durable Object class.
 *
 * Uses SQLite storage for idempotency tracking and auth state persistence.
 */
export class X402SettlementDO extends DurableObject<Env> {
  private initialized = false;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
  }

  /**
   * Ensure the SQLite schema is created.
   * Called lazily on first operation.
   */
  private ensureSchema(): void {
    if (this.initialized) return;

    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS settled_jobs (
        idempotency_key TEXT PRIMARY KEY,
        job_id TEXT NOT NULL,
        auth_id TEXT NOT NULL,
        payer TEXT NOT NULL,
        amount TEXT NOT NULL,
        settled_at INTEGER NOT NULL,
        tx_hash TEXT
      );

      CREATE TABLE IF NOT EXISTS auth_state (
        auth_id TEXT PRIMARY KEY,
        state TEXT NOT NULL DEFAULT 'active',
        failure_count INTEGER NOT NULL DEFAULT 0,
        last_failure_at INTEGER,
        last_failure_reason TEXT,
        updated_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_settled_auth
        ON settled_jobs (auth_id);

      CREATE INDEX IF NOT EXISTS idx_auth_state
        ON auth_state (state);
    `);

    this.initialized = true;
  }

  /**
   * Process a settlement job.
   *
   * Handles idempotency checking, auth state validation, and facilitator calls.
   * Returns a result indicating success, permanent error (no retry), or
   * transient error (should retry via queue).
   */
  async processJob(job: SettlementJob): Promise<SettlementResult> {
    this.ensureSchema();

    // Check idempotency - if we've already processed this job, return cached result
    const existing = this.ctx.storage.sql
      .exec<{ tx_hash: string | null }>(
        `SELECT tx_hash FROM settled_jobs WHERE idempotency_key = ?`,
        job.idempotencyKey,
      )
      .toArray();

    if (existing.length > 0) {
      console.log(`Settlement already processed: ${job.idempotencyKey}`);
      return {
        ok: true,
        txHash: existing[0].tx_hash ?? undefined,
      };
    }

    // Check auth state - reject if blocked
    const authState = this.getAuthState(job.authId);
    if (authState === "blocked") {
      console.log(`Auth blocked, rejecting settlement: ${job.authId}`);
      return {
        ok: false,
        error: "Authorization is blocked due to repeated failures",
        permanent: true,
      };
    }

    // Call facilitator to settle
    const timeoutMs = parseInt(this.env.SETTLE_TIMEOUT_MS, 10) || 5000;
    let response: SettleResponse;

    try {
      response = await settleCharge(
        this.env.X402_FACILITATOR_URL,
        {
          authId: job.authId,
          amount: job.amount,
          idempotencyKey: job.idempotencyKey,
          metadata: {
            logId: job.logId,
            contentHash: job.contentHash,
          },
        },
        timeoutMs,
      );
    } catch (err) {
      // Network or timeout error - transient, should retry
      console.error(`Facilitator call failed: ${err}`);
      this.recordFailure(job.authId, `Network error: ${err}`);
      return {
        ok: false,
        error: `Facilitator unreachable: ${err}`,
        permanent: false,
      };
    }

    if (response.ok) {
      // Success - record in idempotency table and clear failure count
      this.recordSuccess(job, response.txHash);
      return {
        ok: true,
        txHash: response.txHash,
      };
    }

    // Facilitator returned an error
    const isPermanent = response.permanent ?? false;
    this.recordFailure(job.authId, response.error ?? "Unknown error");

    return {
      ok: false,
      error: response.error,
      permanent: isPermanent,
    };
  }

  /**
   * Get the current auth state for an authorization.
   */
  private getAuthState(authId: string): AuthState {
    const rows = this.ctx.storage.sql
      .exec<{ state: string }>(
        `SELECT state FROM auth_state WHERE auth_id = ?`,
        authId,
      )
      .toArray();

    if (rows.length === 0) {
      return "active";
    }

    return rows[0].state as AuthState;
  }

  /**
   * Record a successful settlement.
   */
  private recordSuccess(job: SettlementJob, txHash?: string): void {
    const now = Date.now();

    // Record in idempotency table
    this.ctx.storage.sql.exec(
      `INSERT INTO settled_jobs
        (idempotency_key, job_id, auth_id, payer, amount, settled_at, tx_hash)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      job.idempotencyKey,
      job.jobId,
      job.authId,
      job.payer,
      job.amount,
      now,
      txHash ?? null,
    );

    // Reset failure count on success
    this.ctx.storage.sql.exec(
      `UPDATE auth_state SET failure_count = 0, state = 'active', updated_at = ?
       WHERE auth_id = ?`,
      now,
      job.authId,
    );

    console.log(`Settlement recorded: ${job.idempotencyKey} -> ${txHash}`);
  }

  /**
   * Record a settlement failure and update auth state.
   */
  private recordFailure(authId: string, reason: string): void {
    const now = Date.now();

    // Upsert auth state with incremented failure count
    this.ctx.storage.sql.exec(
      `INSERT INTO auth_state (auth_id, state, failure_count, last_failure_at, last_failure_reason, updated_at)
       VALUES (?, 'active', 1, ?, ?, ?)
       ON CONFLICT(auth_id) DO UPDATE SET
         failure_count = failure_count + 1,
         last_failure_at = excluded.last_failure_at,
         last_failure_reason = excluded.last_failure_reason,
         updated_at = excluded.updated_at`,
      authId,
      now,
      reason,
      now,
    );

    // Check if we need to update state based on failure count
    const rows = this.ctx.storage.sql
      .exec<{ failure_count: number }>(
        `SELECT failure_count FROM auth_state WHERE auth_id = ?`,
        authId,
      )
      .toArray();

    if (rows.length > 0) {
      const failureCount = rows[0].failure_count;
      let newState: AuthState = "active";

      if (failureCount >= BLOCKED_THRESHOLD) {
        newState = "blocked";
      } else if (failureCount >= SUSPECT_THRESHOLD) {
        newState = "suspect";
      }

      if (newState !== "active") {
        this.ctx.storage.sql.exec(
          `UPDATE auth_state SET state = ?, updated_at = ? WHERE auth_id = ?`,
          newState,
          now,
          authId,
        );
        console.log(`Auth state updated: ${authId} -> ${newState}`);
      }
    }
  }

  /**
   * Get auth state for monitoring/debugging.
   * Called via RPC from the worker.
   */
  async getAuthInfo(
    authId: string,
  ): Promise<{ state: AuthState; failureCount: number } | null> {
    this.ensureSchema();

    const rows = this.ctx.storage.sql
      .exec<{ state: string; failure_count: number }>(
        `SELECT state, failure_count FROM auth_state WHERE auth_id = ?`,
        authId,
      )
      .toArray();

    if (rows.length === 0) {
      return null;
    }

    return {
      state: rows[0].state as AuthState,
      failureCount: rows[0].failure_count,
    };
  }
}
