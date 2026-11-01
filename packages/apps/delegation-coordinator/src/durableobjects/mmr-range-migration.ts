/**
 * In-place migration of the delegation MMR range columns from SQLite INTEGER
 * to the 8-byte big-endian BLOB the storage codec reads
 * ({@link ../mmr-index-be8.ts}, plan-2611-01 D2 and D6, FOR-613).
 *
 * SQLite keeps a BLOB unchanged in an INTEGER-affinity column, so no table
 * rebuild is needed: each chunk rewrites at most `chunkRows` rows in place,
 * in one `transactionSync`, and converts in SQL with
 * `unhex(printf('%016x', v))` (workerd bundles SQLite 3.47; `unhex` arrived
 * in 3.41). Progress is the data itself — the next chunk is whatever is still
 * not an 8-byte BLOB — so a crash or eviction between chunks just resumes.
 * Never more than one chunk is held in memory, and only the webhook phase
 * reads row content into JS at all.
 *
 * The owning Durable Object runs {@link MmrRangeMigration.run} once per event
 * (fetch or alarm) until it reports done, schedules an immediate alarm when a
 * budget runs out, and answers range routes 503 until then — so no range
 * query ever sees INTEGER and BLOB bounds side by side.
 *
 * Certificate rows whose range is not a uint64 move to
 * `delegation_certificates_quarantine` (kept for operators, never served);
 * pending rows with a bad range are deleted (the sealer re-raises demand).
 *
 * **Fix-forward only.** Completion installs triggers that reject any range
 * value that is not NULL or an 8-byte BLOB, so a build from before FOR-613
 * deployed over migrated storage fails loudly on its first range write
 * instead of mixing INTEGER and BLOB bounds. There is no down-migration;
 * recover by redeploying a current build.
 */

import { toUint64 } from "@forestrie/delegation-cose";
import { formatDecimalUint64 } from "../decimal-uint64.js";

/** Per-event work limits for {@link MmrRangeMigration.run}. */
export interface MmrRangeMigrationBudget {
  /** Rows converted (or quarantined) per chunk transaction. */
  chunkRows: number;
  /** Rows across all chunks before the event yields to an alarm. */
  eventRows: number;
  /** Wall-clock ms an event may spend before yielding to an alarm. */
  eventMs: number;
}

/**
 * Production budget. Probed locally, workerd rewrites ~20k rows of this
 * shape in ~25 ms, so 2000 rows is a few ms of CPU per event — far under the
 * Durable Object CPU limit, and short enough that a request which also runs a
 * step (fetch does, before routing) is not noticeably delayed. 250 rows per
 * chunk keeps each transaction's index churn (the coverage index and the
 * pending unique index both include the range columns) small. The ms cap is a
 * backstop: workerd may not advance `Date.now()` during synchronous code, so
 * the row caps are the bound that always holds.
 */
export const DEFAULT_MMR_RANGE_MIGRATION_BUDGET: MmrRangeMigrationBudget = {
  chunkRows: 250,
  eventRows: 2000,
  eventMs: 50,
};

/** The tables the migration walks, in order. */
export type MmrRangeMigrationPhase =
  | "pending"
  | "delegation_certificates"
  | "webhook_deliveries";

/**
 * Called inside each chunk's transaction, after its writes and before commit
 * (@internal — tests inject failures and inspect mid-chunk state).
 */
export type MmrRangeMigrationChunkHook = (
  phase: MmrRangeMigrationPhase,
  chunkInEvent: number,
) => void;

/** `schema_meta` key whose presence means the migration has completed. */
const DONE_KEY = "mmr_range_be8";

const PHASES: readonly MmrRangeMigrationPhase[] = [
  "pending",
  "delegation_certificates",
  "webhook_deliveries",
];

/** Rebuild-era temporary tables an earlier build of FOR-613 could leave. */
const LEFTOVER_TABLES = ["delegation_certificates__be8", "pending__be8"];

/** Tables whose range columns the triggers guard. */
const GUARDED_TABLES = ["delegation_certificates", "pending"];

const QUARANTINE_TABLE = "delegation_certificates_quarantine";

/**
 * Create the `schema_meta` key/value table and the certificate quarantine
 * table. Idempotent; ensureSchema calls it every boot.
 *
 * @param sql - The Durable Object's SQL handle.
 * @param certificateColumnsDdl - The live `delegation_certificates` column
 *   DDL without its primary key; the quarantine table copies it and adds
 *   `quarantined_at`, `reason`. No key: a quarantined row is evidence, and a
 *   later row with the same key must not overwrite it.
 */
export function ensureMmrRangeMigrationTables(
  sql: SqlStorage,
  certificateColumnsDdl: string,
): void {
  sql.exec(`
    CREATE TABLE IF NOT EXISTS schema_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
  `);
  sql.exec(`
    CREATE TABLE IF NOT EXISTS ${QUARANTINE_TABLE} (
      ${certificateColumnsDdl},
      quarantined_at INTEGER NOT NULL,
      reason TEXT NOT NULL
    )
  `);
}

/**
 * True once the migration has committed its done flag. One primary-key
 * lookup; the owning DO caches the result, so requests check a boolean.
 */
export function isMmrRangeMigrationDone(sql: SqlStorage): boolean {
  return (
    [...sql.exec(`SELECT 1 FROM schema_meta WHERE key = ?`, DONE_KEY)].length >
    0
  );
}

/**
 * Walks the range tables chunk by chunk. Holds only an in-memory rowid
 * cursor, an optimisation: losing it (eviction) costs one rescan from the
 * start, never correctness, because every chunk re-selects by value.
 */
export class MmrRangeMigration {
  private phaseIndex = 0;
  private cursor = 0;

  constructor(private readonly storage: DurableObjectStorage) {}

  /**
   * Run chunks until the migration completes or the budget runs out.
   *
   * @returns true once the done flag is committed.
   * @throws Whatever a chunk throws; that chunk's transaction rolls back and
   *   the next call resumes from the data.
   */
  run(
    budget: MmrRangeMigrationBudget,
    hook: MmrRangeMigrationChunkHook | null = null,
  ): boolean {
    const startedAt = Date.now();
    let rows = 0;
    let chunk = 0;
    for (;;) {
      if (this.phaseIndex >= PHASES.length) {
        this.storage.transactionSync(() => completeMigration(this.storage.sql));
        return true;
      }
      if (
        rows >= budget.eventRows ||
        Date.now() - startedAt >= budget.eventMs
      ) {
        return false;
      }
      const phase = PHASES[this.phaseIndex]!;
      const limit = Math.min(budget.chunkRows, budget.eventRows - rows);
      const chunkIndex = chunk++;
      const result = this.storage.transactionSync(() => {
        const r = runChunk(this.storage.sql, phase, this.cursor, limit);
        hook?.(phase, chunkIndex);
        return r;
      });
      if (result.rows > 0) {
        rows += result.rows;
        this.cursor = result.lastRowid;
      } else if (this.cursor > 0) {
        // Nothing left past the cursor: rescan once from the start before
        // calling the table done, in case rowids moved under the cursor.
        this.cursor = 0;
      } else {
        this.phaseIndex++;
      }
    }
  }
}

/** Outcome of one chunk: rows it handled and the highest rowid among them. */
interface ChunkResult {
  rows: number;
  lastRowid: number;
}

/** Dispatch one chunk of `phase`, starting after rowid `cursor`. */
function runChunk(
  sql: SqlStorage,
  phase: MmrRangeMigrationPhase,
  cursor: number,
  limit: number,
): ChunkResult {
  if (phase === "webhook_deliveries") {
    return rewriteWebhookChunk(sql, cursor, limit);
  }
  return convertRangeChunk(sql, phase, cursor, limit);
}

/**
 * Convert one chunk of a range table. The chunk is the first `limit` rows
 * past `cursor` (by rowid) whose range is not already be8; the statements
 * then address exactly those rows as `rowid IN (cursor, last]` filtered by
 * the same predicate. Bad rows are quarantined (certificates) or deleted
 * (pending) before the rest convert in SQL.
 */
function convertRangeChunk(
  sql: SqlStorage,
  table: "pending" | "delegation_certificates",
  cursor: number,
  limit: number,
): ChunkResult {
  const needs = `NOT (${be8OrNull("mmr_start")} AND ${be8OrNull("mmr_end")})`;
  const bound = [
    ...sql.exec(
      `SELECT COUNT(*) AS n, MAX(rowid) AS last FROM (
         SELECT rowid FROM ${table}
          WHERE rowid > ? AND ${needs}
          ORDER BY rowid LIMIT ?)`,
      cursor,
      limit,
    ),
  ][0] as { n: number; last: number | null };
  if (bound.n === 0 || bound.last === null) return { rows: 0, lastRowid: 0 };

  const inChunk = `rowid > ? AND rowid <= ?`;
  const bad = `NOT (${convertibleOrDone("mmr_start")} AND ${convertibleOrDone("mmr_end")})`;
  if (table === "delegation_certificates") {
    quarantineBadCertificates(sql, inChunk, bad, cursor, bound.last);
  } else {
    const dropped = [
      ...sql.exec(
        `SELECT id, ${reasonSql()} AS reason FROM pending
          WHERE ${inChunk} AND ${bad}`,
        cursor,
        bound.last,
      ),
    ];
    for (const r of dropped) {
      console.error(
        `mmr range migration: pending "${String(r.id)}" deleted: ${String(r.reason)}`,
      );
    }
  }
  sql.exec(
    `DELETE FROM ${table} WHERE ${inChunk} AND ${bad}`,
    cursor,
    bound.last,
  );
  sql.exec(
    `UPDATE ${table}
        SET mmr_start = ${be8FromInteger("mmr_start")},
            mmr_end = ${be8FromInteger("mmr_end")}
      WHERE ${inChunk} AND ${needs}`,
    cursor,
    bound.last,
  );
  return { rows: bound.n, lastRowid: bound.last };
}

/**
 * Copy this chunk's bad certificate rows into the quarantine table (the
 * caller deletes them from the live table in the same transaction). Columns
 * are the quarantine table's own, so a live table grown by ALTERs in a
 * different column order still copies by name.
 */
function quarantineBadCertificates(
  sql: SqlStorage,
  inChunk: string,
  bad: string,
  from: number,
  to: number,
): void {
  const columns = [
    ...sql.exec(`SELECT name FROM pragma_table_info('${QUARANTINE_TABLE}')`),
  ]
    .map((r) => String(r.name))
    .filter((c) => c !== "quarantined_at" && c !== "reason");
  const list = columns.join(", ");
  const moved = [
    ...sql.exec(
      `INSERT INTO ${QUARANTINE_TABLE} (${list}, quarantined_at, reason)
       SELECT ${list}, ?, ${reasonSql()} FROM delegation_certificates
        WHERE ${inChunk} AND ${bad}
       RETURNING log_id_hex32, certificate_key, reason`,
      Math.floor(Date.now() / 1000),
      from,
      to,
    ),
  ];
  for (const r of moved) {
    console.error(
      `mmr range migration: certificate ${String(r.log_id_hex32)}/${String(
        r.certificate_key,
      )} quarantined: ${String(r.reason)}`,
    );
  }
}

/**
 * Rewrite one chunk of queued `delegation.required` payloads whose
 * `mmrStart` / `mmrEnd` are JSON numbers to decimal strings (D5: receivers
 * parse strings only). Reads at most `limit` payloads; one whose bounds are
 * not a uint64 is deleted with an error log — it cannot be delivered.
 */
function rewriteWebhookChunk(
  sql: SqlStorage,
  cursor: number,
  limit: number,
): ChunkResult {
  const numeric = (path: string) =>
    `json_type(payload_json, '${path}') IN ('integer', 'real')`;
  const rows = [
    ...sql.exec(
      `SELECT rowid AS rid, request_key, payload_json FROM webhook_deliveries
        WHERE rowid > ?
          AND CASE WHEN json_valid(payload_json)
                   THEN ${numeric("$.mmrStart")} OR ${numeric("$.mmrEnd")}
                   ELSE 0 END
        ORDER BY rowid LIMIT ?`,
      cursor,
      limit,
    ),
  ];
  for (const row of rows) {
    const key = String(row.request_key);
    try {
      const payload = JSON.parse(String(row.payload_json)) as Record<
        string,
        unknown
      >;
      payload.mmrStart = formatDecimalUint64(
        toUint64(payload.mmrStart, "mmrStart"),
      );
      payload.mmrEnd = formatDecimalUint64(toUint64(payload.mmrEnd, "mmrEnd"));
      sql.exec(
        `UPDATE webhook_deliveries SET payload_json = ? WHERE rowid = ?`,
        JSON.stringify(payload),
        row.rid,
      );
    } catch (error) {
      sql.exec(`DELETE FROM webhook_deliveries WHERE rowid = ?`, row.rid);
      console.error(
        `mmr range migration: webhook delivery "${key}" deleted: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
  const last = rows.length > 0 ? Number(rows[rows.length - 1]!.rid) : 0;
  return { rows: rows.length, lastRowid: last };
}

/**
 * Finish: drop rebuild-era leftovers, install the range triggers, record the
 * done flag. One transaction, so the flag never exists without the triggers.
 */
function completeMigration(sql: SqlStorage): void {
  for (const table of LEFTOVER_TABLES) {
    sql.exec(`DROP TABLE IF EXISTS ${table}`);
  }
  installMmrRangeTriggers(sql);
  sql.exec(
    `INSERT OR REPLACE INTO schema_meta (key, value) VALUES (?, ?)`,
    DONE_KEY,
    String(Math.floor(Date.now() / 1000)),
  );
}

/**
 * `BEFORE INSERT` / `BEFORE UPDATE` triggers that abort any write leaving a
 * range bound that is neither NULL nor an 8-byte BLOB. They make a rollback
 * to a pre-FOR-613 build (which binds JS numbers) fail loudly.
 */
function installMmrRangeTriggers(sql: SqlStorage): void {
  const valid = `${be8OrNull("NEW.mmr_start")} AND ${be8OrNull("NEW.mmr_end")}`;
  for (const table of GUARDED_TABLES) {
    for (const op of ["INSERT", "UPDATE"]) {
      sql.exec(`
        CREATE TRIGGER IF NOT EXISTS trg_${table}_mmr_range_${op.toLowerCase()}
        BEFORE ${op} ON ${table}
        WHEN NOT (${valid})
        BEGIN
          SELECT RAISE(ABORT, '${table}: mmr_start/mmr_end must be NULL or an 8-byte big-endian BLOB');
        END
      `);
    }
  }
}

/** SQL: the value is already in its final form (be8 BLOB or NULL). */
function be8OrNull(col: string): string {
  return `(${col} IS NULL OR (typeof(${col}) = 'blob' AND length(${col}) = 8))`;
}

/** SQL: the value is final or a non-negative INTEGER the chunk can convert. */
function convertibleOrDone(col: string): string {
  return `(${be8OrNull(col)} OR (typeof(${col}) = 'integer' AND ${col} >= 0))`;
}

/**
 * SQL: the be8 form of a non-negative INTEGER, other values unchanged.
 * `printf('%016x')` of a negative prints its two's complement, hence the
 * guard (bad rows are removed before this runs, but the guard keeps the
 * expression safe on its own).
 */
function be8FromInteger(col: string): string {
  return `CASE WHEN typeof(${col}) = 'integer' AND ${col} >= 0
               THEN unhex(printf('%016x', ${col}))
               ELSE ${col} END`;
}

/** SQL: why a row's range is not a uint64, naming the first bad bound. */
function reasonSql(): string {
  const describe = (col: string) =>
    `'${col} ' || CASE typeof(${col})
       WHEN 'integer' THEN 'is negative'
       WHEN 'blob' THEN 'is a ' || length(${col}) || '-byte blob'
       ELSE 'is ' || typeof(${col}) END`;
  return `CASE WHEN NOT ${convertibleOrDone("mmr_start")}
               THEN ${describe("mmr_start")}
               ELSE ${describe("mmr_end")} END`;
}
