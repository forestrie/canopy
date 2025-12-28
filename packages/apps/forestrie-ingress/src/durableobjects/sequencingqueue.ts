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

/**
 * SequencingQueue Durable Object class.
 *
 * Uses SQLite storage for durability with in-memory caches for performance.
 */
export class SequencingQueue extends DurableObject<Env> {
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

    // Stub: return placeholder seq
    // TODO: Implement in Phase 2
    return { seq: 0 };
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

    // Stub: return zero deleted
    // TODO: Implement in Phase 2
    return { deleted: 0 };
  }

  /**
   * Get queue statistics.
   */
  async stats(): Promise<QueueStats> {
    this.ensureSchema();

    // Stub: return empty stats
    // TODO: Implement in Phase 2
    return {
      pending: 0,
      deadLetters: 0,
      oldestEntryAgeMs: null,
      activePollers: 0,
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
