/**
 * Durable Object for storing sequencing results from the ranger service.
 *
 * There is one SequencedContent object per log, keyed by "{logId}/rangersequence".
 * It stores a bounded set of recent sequenced entries, using FIFO eviction when
 * capacity is exceeded.
 */
import { DurableObject } from "cloudflare:workers";
import type { IndexEntry } from "@canopy/ranger-sequence-types";
import {
  createLeafEnumerator,
  massifLogEntries,
  leafCountForMassifHeight,
  mmrIndexFromLeafIndex,
  massifFirstLeaf,
  Uint64,
} from "@canopy/merklelog";
import type { Env } from "../env.js";

/** Row shape returned by SQLite queries */
type SequencedRow = Record<string, SqlStorageValue> & {
  idtimestamp: ArrayBuffer;
  mmr_index: ArrayBuffer;
  massif_height: number;
};

/**
 * SequencedContent Durable Object.
 *
 * Stores recently sequenced entries indexed by content hash.
 * Uses SQLite for persistent storage with FIFO eviction.
 */
export class SequencedContent extends DurableObject<Env> {
  private initialized = false;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
  }

  /**
   * Resolve a content hash to its sequenced position.
   *
   * @param contentHash - SHA-256 hash of the statement content as bigint
   * @returns The index entry if found, or null if not in cache
   */
  async resolveContent(contentHash: bigint): Promise<IndexEntry | null> {
    this.ensureSchema();

    const hashBlob = hashToBlob(contentHash);
    const rows = this.ctx.storage.sql
      .exec<SequencedRow>(
        "SELECT idtimestamp, mmr_index, massif_height FROM sequenced_content WHERE content_hash = ?",
        hashBlob,
      )
      .toArray();

    if (rows.length === 0) {
      return null;
    }

    const row = rows[0];
    return {
      idtimestamp: blobToBigint(row.idtimestamp),
      mmrIndex: blobToBigint(row.mmr_index),
      massifHeight: row.massif_height,
    };
  }

  /**
   * Batch upsert sequenced entries from raw massif data with FIFO eviction.
   *
   * Directly enumerates the leaf table from the massif blob, avoiding
   * the overhead of serializing/deserializing SequenceRecord[] across RPC.
   *
   * @param massifData - Raw massif blob bytes
   * @param massifHeight - The massif height (1-64)
   * @param massifIndex - The massif index (0-based)
   * @param start - Starting leaf ordinal (0-based, defaults to 0)
   * @param count - Number of leaves to process (defaults to all)
   * @returns Count of rows written
   */
  async batchUpsertFromMassif(
    massifData: ArrayBuffer,
    massifHeight: number,
    massifIndex: number,
    start: number = 0,
    count?: number,
  ): Promise<{ count: number }> {
    this.ensureSchema();

    if (massifHeight < 1 || massifHeight > 64) {
      throw new Error(`Invalid massifHeight: ${massifHeight} (expected 1-64)`);
    }

    const buffer = new Uint8Array(massifData);
    const capacity = this.getCapacity(massifHeight);

    // Calculate leaf count from blob size
    const maxLeavesPerMassif = leafCountForMassifHeight(massifHeight);
    const logEntries = massifLogEntries(massifData.byteLength, massifHeight);
    const totalLeaves = Math.min(
      Number(logEntries),
      Number(maxLeavesPerMassif),
    );

    // Determine how many leaves to process
    const leafCount =
      count !== undefined
        ? Math.min(count, totalLeaves - start)
        : totalLeaves - start;

    if (leafCount <= 0) {
      return { count: 0 };
    }

    // Create leaf enumerator
    const enumerate = createLeafEnumerator(
      buffer,
      massifHeight,
      leafCount,
      { idtimestamp: true, valueBytes: true },
      start,
    );

    // Compute the global first leaf index for this massif
    const firstLeafIndex = massifFirstLeaf(massifHeight, massifIndex);

    return this.ctx.storage.transactionSync(() => {
      let rowCount = 0;

      for (const leaf of enumerate()) {
        const idtimestamp = leaf.idtimestamp!;
        const contentHash = leaf.valueBytes!;

        // Calculate global leaf index and MMR index
        const globalLeafIndex = firstLeafIndex + BigInt(leaf.ordinal);
        const mmrIndex = mmrIndexFromLeafIndex(
          new Uint64(globalLeafIndex),
        ).toBigInt();

        // Convert content hash bytes to blob (already 32 bytes)
        const hashBlob = contentHash.buffer.slice(
          contentHash.byteOffset,
          contentHash.byteOffset + contentHash.byteLength,
        );
        const idtsBlob = bigintToBlob(idtimestamp);
        const mmrBlob = bigintToBlob(mmrIndex);

        const result = this.ctx.storage.sql.exec(
          `INSERT INTO sequenced_content (content_hash, idtimestamp, mmr_index, massif_height)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(content_hash) DO UPDATE SET
             idtimestamp = excluded.idtimestamp,
             mmr_index = excluded.mmr_index,
             massif_height = excluded.massif_height`,
          hashBlob,
          idtsBlob,
          mmrBlob,
          massifHeight,
        );
        rowCount += result.rowsWritten;
      }

      // Evict oldest entries (by idtimestamp) if over capacity
      const countResult = this.ctx.storage.sql
        .exec<{ cnt: number }>("SELECT COUNT(*) as cnt FROM sequenced_content")
        .toArray()[0];

      const currentCount = countResult?.cnt ?? 0;
      if (currentCount > capacity) {
        const toEvict = currentCount - capacity;
        this.ctx.storage.sql.exec(
          `DELETE FROM sequenced_content
           WHERE content_hash IN (
             SELECT content_hash FROM sequenced_content
             ORDER BY idtimestamp ASC
             LIMIT ?
           )`,
          toEvict,
        );
      }

      return { count: rowCount };
    });
  }

  /**
   * Initialize the SQLite schema if not already done.
   */
  private ensureSchema(): void {
    if (this.initialized) return;

    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS sequenced_content (
        content_hash BLOB PRIMARY KEY,
        idtimestamp BLOB NOT NULL,
        mmr_index BLOB NOT NULL,
        massif_height INTEGER NOT NULL
      )
    `);

    // Index on idtimestamp for efficient FIFO eviction (oldest first)
    this.ctx.storage.sql.exec(`
      CREATE INDEX IF NOT EXISTS idx_idtimestamp ON sequenced_content (idtimestamp)
    `);

    // Index on mmr_index for potential future queries
    this.ctx.storage.sql.exec(`
      CREATE INDEX IF NOT EXISTS idx_mmr_index ON sequenced_content (mmr_index)
    `);

    this.initialized = true;
  }

  /**
   * Get the capacity limit based on massif height.
   * Capacity = 2^(massifHeight - 1)
   */
  private getCapacity(massifHeight: number): number {
    if (massifHeight < 1 || massifHeight > 64) {
      throw new Error(`Invalid massifHeight: ${massifHeight} (expected 1-64)`);
    }
    // For massifHeight=1, capacity=1; for massifHeight=14, capacity=8192
    return 1 << (massifHeight - 1);
  }
}

// --- Module-level helper functions (leaf-most, called by class methods) ---

/**
 * Convert a bigint to an 8-byte big-endian ArrayBuffer for SQLite BLOB storage.
 */
function bigintToBlob(value: bigint): ArrayBuffer {
  const buffer = new ArrayBuffer(8);
  const view = new DataView(buffer);
  view.setBigUint64(0, value, false); // big-endian
  return buffer;
}

/**
 * Convert a 32-byte bigint (SHA-256 hash) to ArrayBuffer for SQLite BLOB storage.
 */
function hashToBlob(value: bigint): ArrayBuffer {
  const buffer = new ArrayBuffer(32);
  const view = new DataView(buffer);
  // Store as two 128-bit halves (four 64-bit words)
  const mask64 = (1n << 64n) - 1n;
  view.setBigUint64(24, value & mask64, false);
  view.setBigUint64(16, (value >> 64n) & mask64, false);
  view.setBigUint64(8, (value >> 128n) & mask64, false);
  view.setBigUint64(0, (value >> 192n) & mask64, false);
  return buffer;
}

/**
 * Convert an ArrayBuffer (8 bytes) back to bigint.
 */
function blobToBigint(buffer: ArrayBuffer): bigint {
  const view = new DataView(buffer);
  return view.getBigUint64(0, false); // big-endian
}
