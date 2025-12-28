/**
 * SequencingQueue Durable Object
 *
 * A domain-aware sequencing queue that replaces the R2_LEAVES buffer and
 * Cloudflare Queue for ingress processing. Entries are enqueued by canopy-api
 * and pulled by ranger instances via HTTP.
 *
 * See: arbor/docs/arc-cloudflare-do-ingress.md
 */

import { DurableObject } from "cloudflare:workers";
import type {
  PullRequest,
  PullResponse,
  QueueStats,
  EnqueueExtras,
} from "@canopy/forestrie-ingress-types";
import type { Env } from "../env.js";

/** Maximum pending entries before backpressure kicks in */
const MAX_PENDING = 100_000;

/** Maximum size for extra fields in bytes */
const MAX_EXTRA_SIZE = 32;

/**
 * SequencingQueue Durable Object class.
 *
 * Uses SQLite storage for durability with in-memory caches for performance.
 */
export class SequencingQueue extends DurableObject<Env> {
  private initialized = false;

  /** In-memory count of pending entries (not yet acked) */
  private pendingCount = 0;

  /** Next sequence number to assign */
  private nextSeq = 1;

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
      CREATE TABLE IF NOT EXISTS queue_entries (
        seq INTEGER PRIMARY KEY,
        log_id BLOB NOT NULL,
        content_hash BLOB NOT NULL,
        extra0 BLOB CHECK (extra0 IS NULL OR length(extra0) <= 32),
        extra1 BLOB CHECK (extra1 IS NULL OR length(extra1) <= 32),
        extra2 BLOB CHECK (extra2 IS NULL OR length(extra2) <= 32),
        extra3 BLOB CHECK (extra3 IS NULL OR length(extra3) <= 32),
        visible_after INTEGER,
        attempts INTEGER NOT NULL DEFAULT 0,
        enqueued_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_log_visible
        ON queue_entries (log_id, visible_after);

      CREATE INDEX IF NOT EXISTS idx_visible
        ON queue_entries (visible_after);

      CREATE INDEX IF NOT EXISTS idx_attempts
        ON queue_entries (attempts);

      CREATE TABLE IF NOT EXISTS dead_letters (
        seq INTEGER PRIMARY KEY,
        log_id BLOB NOT NULL,
        content_hash BLOB NOT NULL,
        extra0 BLOB,
        extra1 BLOB,
        extra2 BLOB,
        extra3 BLOB,
        attempts INTEGER NOT NULL,
        enqueued_at INTEGER NOT NULL,
        dead_at INTEGER NOT NULL,
        reason TEXT
      );
    `);

    this.initialized = true;

    // Initialize in-memory state from SQLite
    this.initializeFromStorage();
  }

  /**
   * Initialize in-memory counters from SQLite state.
   * Called once after schema creation.
   */
  private initializeFromStorage(): void {
    // Get pending count
    const countResult = this.ctx.storage.sql
      .exec<{ cnt: number }>("SELECT COUNT(*) as cnt FROM queue_entries")
      .toArray();
    this.pendingCount = countResult[0]?.cnt ?? 0;

    // Get max seq for next assignment
    const maxSeqResult = this.ctx.storage.sql
      .exec<{ max_seq: number | null }>("SELECT MAX(seq) as max_seq FROM queue_entries")
      .toArray();
    const maxSeq = maxSeqResult[0]?.max_seq ?? 0;
    this.nextSeq = (maxSeq ?? 0) + 1;
  }

  /**
   * Validate that an ArrayBuffer is within the allowed size for extra fields.
   */
  private validateExtraSize(extra: ArrayBuffer | undefined, name: string): void {
    if (extra && extra.byteLength > MAX_EXTRA_SIZE) {
      throw new Error(
        `${name} exceeds maximum size: ${extra.byteLength} > ${MAX_EXTRA_SIZE} bytes`,
      );
    }
  }

  /**
   * Enqueue a new entry for sequencing.
   */
  async enqueue(
    logId: ArrayBuffer,
    contentHash: ArrayBuffer,
    extras?: EnqueueExtras,
  ): Promise<{ seq: number }> {
    this.ensureSchema();

    // Validate extra field sizes
    if (extras) {
      this.validateExtraSize(extras.extra0, "extra0");
      this.validateExtraSize(extras.extra1, "extra1");
      this.validateExtraSize(extras.extra2, "extra2");
      this.validateExtraSize(extras.extra3, "extra3");
    }

    // Check backpressure
    if (this.pendingCount >= MAX_PENDING) {
      throw new Error(
        `Queue full: pending count ${this.pendingCount} >= ${MAX_PENDING}`,
      );
    }

    const seq = this.nextSeq++;
    const now = Date.now();

    this.ctx.storage.sql.exec(
      `INSERT INTO queue_entries
       (seq, log_id, content_hash, extra0, extra1, extra2, extra3, visible_after, enqueued_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
      seq,
      logId,
      contentHash,
      extras?.extra0 ?? null,
      extras?.extra1 ?? null,
      extras?.extra2 ?? null,
      extras?.extra3 ?? null,
      now,
    );

    this.pendingCount++;

    return { seq };
  }

  /**
   * Pull entries assigned to this poller.
   */
  async pull(request: PullRequest): Promise<PullResponse> {
    this.ensureSchema();

    // Stub: return empty response
    // TODO: Implement in Phase 3
    return {
      version: 1,
      leaseExpiry: Date.now() + request.visibilityMs,
      logGroups: [],
    };
  }

  /**
   * Acknowledge a contiguous range of entries for a log.
   */
  async ackRange(
    logId: ArrayBuffer,
    fromSeq: number,
    toSeq: number,
  ): Promise<{ deleted: number }> {
    this.ensureSchema();

    const result = this.ctx.storage.sql.exec(
      `DELETE FROM queue_entries
       WHERE log_id = ? AND seq >= ? AND seq <= ?`,
      logId,
      fromSeq,
      toSeq,
    );

    const deleted = result.rowsWritten;
    this.pendingCount = Math.max(0, this.pendingCount - deleted);

    return { deleted };
  }

  /**
   * Get queue statistics.
   */
  async stats(): Promise<QueueStats> {
    this.ensureSchema();

    // Count dead letters
    const dlResult = this.ctx.storage.sql
      .exec<{ cnt: number }>("SELECT COUNT(*) as cnt FROM dead_letters")
      .toArray();
    const deadLetters = dlResult[0]?.cnt ?? 0;

    // Get oldest entry age
    const oldestResult = this.ctx.storage.sql
      .exec<{ oldest: number | null }>(
        "SELECT MIN(enqueued_at) as oldest FROM queue_entries",
      )
      .toArray();
    const oldestEnqueuedAt = oldestResult[0]?.oldest;
    const oldestEntryAgeMs =
      oldestEnqueuedAt !== null ? Date.now() - oldestEnqueuedAt : null;

    // Active pollers will be tracked in Phase 3
    const activePollers = 0;

    return {
      pending: this.pendingCount,
      deadLetters,
      oldestEntryAgeMs,
      activePollers,
    };
  }

  /**
   * Handle HTTP requests to the DO.
   * This will be used for ranger pull/ack endpoints in Phase 4.
   */
  async fetch(request: Request): Promise<Response> {
    // Stub: return 501 Not Implemented
    // TODO: Implement HTTP handlers in Phase 4
    return new Response("Not Implemented", { status: 501 });
  }
}
