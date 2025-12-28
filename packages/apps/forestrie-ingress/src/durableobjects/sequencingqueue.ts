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
  LogGroup,
  Entry,
  QueueStats,
  EnqueueExtras,
} from "@canopy/forestrie-ingress-types";
import type { Env } from "../env.js";

/** Maximum pending entries before backpressure kicks in */
const MAX_PENDING = 100_000;

/** Maximum size for extra fields in bytes */
const MAX_EXTRA_SIZE = 32;

/** Poller is considered inactive after this many ms without a pull */
const POLLER_TIMEOUT_MS = 60_000;

/** Maximum delivery attempts before moving to dead letters */
const MAX_ATTEMPTS = 5;

/**
 * Maximum number of active pollers before rejecting new ones.
 * See: arbor/docs/adr-0007-cf-do-ingress-poller-limits.md
 */
const MAX_POLLERS = 500;

/** Poller state tracked in memory */
interface PollerState {
  lastSeen: number;
}

/**
 * Simple hash function (djb2) for consistent hashing.
 * Returns a non-negative 32-bit integer.
 *
 * This is intentionally a non-cryptographic hash. It's used only for load
 * distribution across pollers, which is not security-sensitive.
 * See: arbor/docs/adr-0006-cf-do-ingress-hash-function.md
 *
 * @internal Exported for testing
 */
export function djb2Hash(data: Uint8Array): number {
  let hash = 5381;
  for (let i = 0; i < data.length; i++) {
    hash = ((hash << 5) + hash + data[i]) >>> 0;
  }
  return hash >>> 0;
}

/**
 * Assign a log to a poller using consistent hashing.
 * Given a sorted list of poller IDs, returns the assigned poller ID.
 * @internal Exported for testing
 */
export function assignLog(logId: ArrayBuffer, pollerIds: string[]): string {
  if (pollerIds.length === 0) {
    throw new Error("No active pollers");
  }
  const sorted = [...pollerIds].sort();
  const hash = djb2Hash(new Uint8Array(logId));
  return sorted[hash % sorted.length];
}

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

  /** Active pollers tracked in memory */
  private pollers: Map<string, PollerState> = new Map();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
  }

  /**
   * Update poller state and expire stale pollers.
   * Returns the list of active poller IDs, or null if the poller limit has
   * been reached and this is a new poller (existing pollers are always updated).
   *
   * See: arbor/docs/adr-0007-cf-do-ingress-poller-limits.md
   */
  private updatePollers(pollerId: string): string[] | null {
    const now = Date.now();

    // Expire stale pollers first
    const cutoff = now - POLLER_TIMEOUT_MS;
    for (const [id, state] of this.pollers) {
      if (state.lastSeen < cutoff) {
        this.pollers.delete(id);
      }
    }

    // Check if this is a new poller and we're at capacity
    const isNewPoller = !this.pollers.has(pollerId);
    if (isNewPoller && this.pollers.size >= MAX_POLLERS) {
      // Don't add new poller, return null to signal empty response
      return null;
    }

    // Update/add the poller
    this.pollers.set(pollerId, { lastSeen: now });
    return Array.from(this.pollers.keys());
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
        enqueued_at INTEGER NOT NULL,
        -- Sequencing result fields (NULL until sequenced)
        leaf_index INTEGER DEFAULT NULL,
        massif_index INTEGER DEFAULT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_log_visible
        ON queue_entries (log_id, visible_after);

      CREATE INDEX IF NOT EXISTS idx_visible
        ON queue_entries (visible_after);

      CREATE INDEX IF NOT EXISTS idx_attempts
        ON queue_entries (attempts);

      -- For resolveContent lookups by content hash
      CREATE INDEX IF NOT EXISTS idx_content_hash
        ON queue_entries (content_hash);

      -- For cleanup queries (sequenced entries per log)
      CREATE INDEX IF NOT EXISTS idx_log_leaf
        ON queue_entries (log_id, leaf_index);

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
    // Get pending count (only entries not yet sequenced)
    const countResult = this.ctx.storage.sql
      .exec<{
        cnt: number;
      }>("SELECT COUNT(*) as cnt FROM queue_entries WHERE leaf_index IS NULL")
      .toArray();
    this.pendingCount = countResult[0]?.cnt ?? 0;

    // Get max seq for next assignment
    const maxSeqResult = this.ctx.storage.sql
      .exec<{
        max_seq: number | null;
      }>("SELECT MAX(seq) as max_seq FROM queue_entries")
      .toArray();
    const maxSeq = maxSeqResult[0]?.max_seq ?? 0;
    this.nextSeq = (maxSeq ?? 0) + 1;
  }

  /**
   * Validate that an ArrayBuffer is within the allowed size for extra fields.
   */
  private validateExtraSize(
    extra: ArrayBuffer | undefined,
    name: string,
  ): void {
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

    const now = Date.now();
    const leaseExpiry = now + request.visibilityMs;

    // Update poller state and get active pollers
    const activePollerIds = this.updatePollers(request.pollerId);

    // If poller limit reached and this is a new poller, return empty response
    if (activePollerIds === null) {
      return {
        version: 1,
        leaseExpiry,
        logGroups: [],
      };
    }

    // First, move poison messages to dead letters
    this.movePoisonToDeadLetters(now);

    // Find logs with visible pending entries (not yet sequenced)
    const visibleLogs = this.ctx.storage.sql
      .exec<{ log_id: ArrayBuffer }>(
        `SELECT DISTINCT log_id FROM queue_entries
         WHERE leaf_index IS NULL
           AND (visible_after IS NULL OR visible_after <= ?)`,
        now,
      )
      .toArray();

    // Filter to logs assigned to this poller
    const assignedLogIds: ArrayBuffer[] = [];
    for (const row of visibleLogs) {
      const assignedPoller = assignLog(row.log_id, activePollerIds);
      if (assignedPoller === request.pollerId) {
        assignedLogIds.push(row.log_id);
      }
    }

    // Build grouped response
    const logGroups: LogGroup[] = [];
    let totalEntries = 0;

    for (const logId of assignedLogIds) {
      if (totalEntries >= request.batchSize) break;

      const remaining = request.batchSize - totalEntries;
      const entries = this.pullEntriesForLog(
        logId,
        remaining,
        leaseExpiry,
        now,
      );

      if (entries.length > 0) {
        // Get seq range from the first query (we need to query again for seqs)
        const seqResult = this.ctx.storage.sql
          .exec<{ seq_lo: number; seq_hi: number }>(
            `SELECT MIN(seq) as seq_lo, MAX(seq) as seq_hi FROM queue_entries
             WHERE log_id = ? AND visible_after = ?`,
            logId,
            leaseExpiry,
          )
          .toArray();

        const seqLo = seqResult[0]?.seq_lo ?? 0;
        const seqHi = seqResult[0]?.seq_hi ?? 0;

        logGroups.push({
          logId,
          seqLo,
          seqHi,
          entries,
        });

        totalEntries += entries.length;
      }
    }

    return {
      version: 1,
      leaseExpiry,
      logGroups,
    };
  }

  /**
   * Pull entries for a single log, update visibility, and increment attempts.
   * Only pulls pending entries (leaf_index IS NULL).
   */
  private pullEntriesForLog(
    logId: ArrayBuffer,
    limit: number,
    leaseExpiry: number,
    now: number,
  ): Entry[] {
    // Query visible pending entries for this log (not yet sequenced)
    const rows = this.ctx.storage.sql
      .exec<{
        seq: number;
        content_hash: ArrayBuffer;
        extra0: ArrayBuffer | null;
        extra1: ArrayBuffer | null;
        extra2: ArrayBuffer | null;
        extra3: ArrayBuffer | null;
      }>(
        `SELECT seq, content_hash, extra0, extra1, extra2, extra3
         FROM queue_entries
         WHERE log_id = ? AND leaf_index IS NULL
           AND (visible_after IS NULL OR visible_after <= ?)
         ORDER BY seq ASC
         LIMIT ?`,
        logId,
        now,
        limit,
      )
      .toArray();

    if (rows.length === 0) return [];

    // Update visibility and increment attempts
    const seqs = rows.map((r) => r.seq);
    const seqLo = seqs[0];
    const seqHi = seqs[seqs.length - 1];

    this.ctx.storage.sql.exec(
      `UPDATE queue_entries
       SET visible_after = ?, attempts = attempts + 1
       WHERE log_id = ? AND seq >= ? AND seq <= ?`,
      leaseExpiry,
      logId,
      seqLo,
      seqHi,
    );

    return rows.map((row) => ({
      contentHash: row.content_hash,
      extra0: row.extra0,
      extra1: row.extra1,
      extra2: row.extra2,
      extra3: row.extra3,
    }));
  }

  /**
   * Move entries exceeding MAX_ATTEMPTS to dead_letters table.
   * Only affects pending entries (not yet sequenced).
   */
  private movePoisonToDeadLetters(now: number): void {
    // Find poison entries (pending only)
    const poisonEntries = this.ctx.storage.sql
      .exec<{
        seq: number;
        log_id: ArrayBuffer;
        content_hash: ArrayBuffer;
        extra0: ArrayBuffer | null;
        extra1: ArrayBuffer | null;
        extra2: ArrayBuffer | null;
        extra3: ArrayBuffer | null;
        attempts: number;
        enqueued_at: number;
      }>(
        `SELECT seq, log_id, content_hash, extra0, extra1, extra2, extra3, attempts, enqueued_at
         FROM queue_entries WHERE leaf_index IS NULL AND attempts >= ?`,
        MAX_ATTEMPTS,
      )
      .toArray();

    for (const entry of poisonEntries) {
      // Insert into dead_letters
      this.ctx.storage.sql.exec(
        `INSERT INTO dead_letters
         (seq, log_id, content_hash, extra0, extra1, extra2, extra3, attempts, enqueued_at, dead_at, reason)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        entry.seq,
        entry.log_id,
        entry.content_hash,
        entry.extra0,
        entry.extra1,
        entry.extra2,
        entry.extra3,
        entry.attempts,
        entry.enqueued_at,
        now,
        `exceeded max attempts (${MAX_ATTEMPTS})`,
      );

      // Delete from queue_entries
      this.ctx.storage.sql.exec(
        `DELETE FROM queue_entries WHERE seq = ?`,
        entry.seq,
      );

      this.pendingCount = Math.max(0, this.pendingCount - 1);
    }
  }

  /**
   * Acknowledge entries by marking them as sequenced with leaf/massif indices.
   *
   * Updates the first N entries (by seq order) for the given log starting from
   * seqLo, setting their leaf_index and massif_index. Entries are retained
   * (not deleted) to serve as sequencing result cache for resolveContent.
   *
   * massifIndex is derived from firstLeafIndex and massifHeight.
   * Cleanup runs on each ack, retaining ~2 massifs worth of sequenced entries.
   *
   * See: arbor/docs/arc-cloudflare-do-ingress.md section 3.12
   */
  async ackFirst(
    logId: ArrayBuffer,
    seqLo: number,
    limit: number,
    firstLeafIndex: number,
    massifHeight: number,
  ): Promise<{ acked: number }> {
    this.ensureSchema();

    if (limit <= 0) {
      return { acked: 0 };
    }

    const leavesPerMassif = 1 << massifHeight;

    // First, find the seq values to update
    const toUpdate = this.ctx.storage.sql
      .exec<{ seq: number }>(
        `SELECT seq FROM queue_entries
         WHERE log_id = ? AND seq >= ? AND leaf_index IS NULL
         ORDER BY seq ASC
         LIMIT ?`,
        logId,
        seqLo,
        limit,
      )
      .toArray();

    if (toUpdate.length === 0) {
      return { acked: 0 };
    }

    // Update each entry with its computed leaf_index and derived massif_index
    for (let i = 0; i < toUpdate.length; i++) {
      const leafIndex = firstLeafIndex + i;
      const massifIndex = Math.floor(leafIndex / leavesPerMassif);

      this.ctx.storage.sql.exec(
        `UPDATE queue_entries
         SET leaf_index = ?, massif_index = ?, visible_after = NULL
         WHERE seq = ?`,
        leafIndex,
        massifIndex,
        toUpdate[i].seq,
      );
    }

    const acked = toUpdate.length;
    this.pendingCount = Math.max(0, this.pendingCount - acked);

    // Cleanup: retain ~2 massifs worth of sequenced entries per log
    const retainCount = leavesPerMassif * 2;

    this.ctx.storage.sql.exec(
      `DELETE FROM queue_entries
       WHERE log_id = ?
         AND leaf_index IS NOT NULL
         AND leaf_index < (
           SELECT COALESCE(MAX(leaf_index), 0) - ?
           FROM queue_entries
           WHERE log_id = ? AND leaf_index IS NOT NULL
         )`,
      logId,
      retainCount,
      logId,
    );

    return { acked };
  }

  /**
   * Resolve a content hash to its sequencing result.
   *
   * Returns the leaf_index and massif_index if the entry has been sequenced,
   * or null if still pending or unknown.
   *
   * See: arbor/docs/arc-cloudflare-do-ingress.md section 3.12.5
   */
  async resolveContent(
    contentHash: ArrayBuffer,
  ): Promise<{ leafIndex: number; massifIndex: number } | null> {
    this.ensureSchema();

    const result = this.ctx.storage.sql
      .exec<{ leaf_index: number; massif_index: number }>(
        `SELECT leaf_index, massif_index
         FROM queue_entries
         WHERE content_hash = ? AND leaf_index IS NOT NULL`,
        contentHash,
      )
      .toArray();

    if (result.length === 0) {
      return null;
    }

    return {
      leafIndex: result[0].leaf_index,
      massifIndex: result[0].massif_index,
    };
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

    // Get oldest pending entry age (only entries not yet sequenced)
    const now = Date.now();
    const oldestResult = this.ctx.storage.sql
      .exec<{
        oldest: number | null;
      }>(
        "SELECT MIN(enqueued_at) as oldest FROM queue_entries WHERE leaf_index IS NULL",
      )
      .toArray();
    const oldestEnqueuedAt = oldestResult[0]?.oldest;
    const oldestEntryAgeMs =
      oldestEnqueuedAt !== null ? now - oldestEnqueuedAt : null;

    // Expire stale pollers and count active ones
    const cutoff = now - POLLER_TIMEOUT_MS;
    for (const [id, state] of this.pollers) {
      if (state.lastSeen < cutoff) {
        this.pollers.delete(id);
      }
    }
    const activePollers = this.pollers.size;

    return {
      pending: this.pendingCount,
      deadLetters,
      oldestEntryAgeMs,
      activePollers,
      pollerLimitReached: activePollers >= MAX_POLLERS,
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
