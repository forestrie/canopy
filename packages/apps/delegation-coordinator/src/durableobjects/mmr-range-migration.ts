/**
 * In-place migration of the delegation MMR range columns from SQLite INTEGER
 * to the 8-byte big-endian BLOB the storage codec reads
 * ({@link ../mmr-index-be8.ts}: uint64 bounds stored big-endian so byte order
 * is numeric order).
 *
 * SQLite keeps a BLOB unchanged in an INTEGER-affinity column, so no table
 * rebuild is needed and nothing temporary is created. The migration walks
 * each table in fixed rowid windows: a chunk is one `transactionSync` over
 * the rows with rowid in `(cursor, cursor + chunkRows]` (the window starts at
 * the next existing rowid, so gaps cost nothing), converting in SQL with
 * `unhex(printf('%016x', v))` (workerd bundles SQLite 3.47; `unhex` arrived in
 * 3.41). The new cursor is written to `schema_meta` in the same transaction,
 * so eviction or a failed chunk resumes at the last committed window. Every
 * statement in a chunk is bounded by the window, so per-event work is bounded
 * by the budget regardless of table size or how much is already converted.
 *
 * The owning Durable Object runs {@link MmrRangeMigration.run} once per event
 * (fetch or alarm) until it reports done, schedules an immediate alarm when a
 * budget runs out, and answers range routes 503 until then — so no range
 * query ever sees INTEGER and BLOB bounds side by side, and those routes are
 * the only writers of the range tables, which keeps each table's rowid
 * extent stable while it is walked (rows appended anyway are picked up: the
 * extent is re-read before a table is called done).
 *
 * Certificate rows whose range is not a uint64 move to
 * `delegation_certificates_quarantine` (kept for operators, never served);
 * pending rows with a bad range are deleted (the sealer re-raises demand).
 *
 * **Fix-forward only.** Completion installs triggers that reject any range
 * value that is not NULL or an 8-byte BLOB, so an older build that binds
 * range bounds as numbers, deployed over migrated storage, fails loudly on
 * its first range write instead of mixing INTEGER and BLOB bounds. There is
 * no down-migration; recover by redeploying a current build. Completion also
 * deletes the progress record, leaving only the done flag.
 */

import { toUint64 } from "@forestrie/delegation-cose";
import { formatDecimalUint64 } from "../decimal-uint64.js";

/** Per-event work limits for {@link MmrRangeMigration.run}. */
export interface MmrRangeMigrationBudget {
  /** Rowid window width: the most rows one chunk transaction examines. */
  chunkRows: number;
  /** Rows examined across all chunks before the event yields to an alarm. */
  eventRows: number;
  /**
   * Wall-clock ms an event may spend before yielding. A backstop only:
   * workerd may freeze `Date.now()` during synchronous execution (it advances
   * on I/O), so the row and window caps are the bound that always holds.
   */
  eventMs: number;
}

/**
 * Production budget. Probed locally, workerd rewrites ~20k rows of this
 * shape in ~25 ms, so 2000 examined rows is a few ms of CPU per event — far
 * under the Durable Object CPU limit, and short enough that a request which
 * also runs a step (fetch does, before routing) is not noticeably delayed.
 * 250-row windows keep each transaction's index churn (the coverage index
 * and the pending unique index both include the range columns) small.
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

/** What one chunk did, as reported to {@link MmrRangeMigrationChunkHook}. */
export interface MmrRangeMigrationChunk {
  phase: MmrRangeMigrationPhase;
  /** 0 for the first chunk of an event. */
  chunkInEvent: number;
  /** Rows in the window (0 for a step that only measures or advances). */
  examined: number;
  /** Window bounds: rowid in `(from, to]`. */
  from: number;
  to: number;
}

/**
 * Called inside each chunk's transaction, after its writes and before commit
 * (@internal — tests inject failures and measure per-event work).
 */
export type MmrRangeMigrationChunkHook = (
  chunk: MmrRangeMigrationChunk,
) => void;

/** `schema_meta` key whose presence means the migration has completed. */
const DONE_KEY = "mmr_range_be8";

/** `schema_meta` key holding {@link Progress} while the migration runs. */
const PROGRESS_KEY = "mmr_range_be8_progress";

const PHASES: readonly MmrRangeMigrationPhase[] = [
  "pending",
  "delegation_certificates",
  "webhook_deliveries",
];

/** Temporary tables an earlier, rebuild-based build of this could leave. */
const LEFTOVER_TABLES = ["delegation_certificates__be8", "pending__be8"];

/** Tables whose range columns the triggers guard. */
const GUARDED_TABLES = ["delegation_certificates", "pending"];

const QUARANTINE_TABLE = "delegation_certificates_quarantine";

/**
 * Persisted position: the table being walked, the last rowid handled, and
 * the table's highest rowid when its walk began (null until measured).
 */
interface Progress {
  phase: MmrRangeMigrationPhase;
  cursor: number;
  maxRowid: number | null;
}

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
 * Walks the range tables window by window. Holds no state of its own: the
 * position lives in `schema_meta`, so any instance (after eviction, or a
 * second object) continues where the last committed chunk left off.
 */
export class MmrRangeMigration {
  constructor(private readonly storage: DurableObjectStorage) {}

  /**
   * Run chunks until the migration completes or the budget runs out.
   *
   * @returns true once the done flag is committed.
   * @throws Whatever a chunk throws; that chunk's transaction (writes and
   *   cursor alike) rolls back and the next call repeats the window.
   */
  run(
    budget: MmrRangeMigrationBudget,
    hook: MmrRangeMigrationChunkHook | null = null,
  ): boolean {
    const sql = this.storage.sql;
    if (isMmrRangeMigrationDone(sql)) return true;
    const startedAt = Date.now();
    let progress: Progress | null = readProgress(sql);
    let examined = 0;
    let chunkInEvent = 0;
    for (;;) {
      if (progress === null) {
        this.storage.transactionSync(() => completeMigration(sql));
        return true;
      }
      if (
        examined >= budget.eventRows ||
        Date.now() - startedAt >= budget.eventMs
      ) {
        return false;
      }
      const width = Math.min(budget.chunkRows, budget.eventRows - examined);
      const current = progress;
      const step = this.storage.transactionSync(() => {
        const s = stepPhase(sql, current, width);
        writeProgress(sql, s.next);
        hook?.({
          phase: current.phase,
          chunkInEvent,
          examined: s.examined,
          from: s.from,
          to: s.to,
        });
        return s;
      });
      chunkInEvent++;
      examined += step.examined;
      progress = step.next;
    }
  }
}

/** One step's outcome: the next position (null when all phases are done). */
interface Step {
  next: Progress | null;
  examined: number;
  from: number;
  to: number;
}

/** Read the persisted position; a missing record means "start". */
function readProgress(sql: SqlStorage): Progress {
  const rows = [
    ...sql.exec(`SELECT value FROM schema_meta WHERE key = ?`, PROGRESS_KEY),
  ];
  if (rows.length === 0) {
    return { phase: PHASES[0]!, cursor: 0, maxRowid: null };
  }
  return JSON.parse(String(rows[0]!.value)) as Progress;
}

function writeProgress(sql: SqlStorage, progress: Progress | null): void {
  if (progress === null) return;
  sql.exec(
    `INSERT OR REPLACE INTO schema_meta (key, value) VALUES (?, ?)`,
    PROGRESS_KEY,
    JSON.stringify(progress),
  );
}

/**
 * Advance one step: measure a table's extent when its walk begins, process
 * the next rowid window, or — once the cursor reaches the measured extent —
 * re-measure (rows appended meanwhile extend the walk) and move to the next
 * table. Measuring is `MAX(rowid)` and finding a window start is
 * `MIN(rowid) WHERE rowid > cursor`: both are rowid b-tree seeks.
 */
function stepPhase(sql: SqlStorage, p: Progress, width: number): Step {
  const idle = { examined: 0, from: p.cursor, to: p.cursor };
  if (p.maxRowid === null || p.cursor >= p.maxRowid) {
    const max = maxRowid(sql, p.phase);
    if (max !== null && max > p.cursor) {
      return { ...idle, next: { ...p, maxRowid: max } };
    }
    const index = PHASES.indexOf(p.phase) + 1;
    const next =
      index < PHASES.length
        ? { phase: PHASES[index]!, cursor: 0, maxRowid: null }
        : null;
    return { ...idle, next };
  }
  const startRow = [
    ...sql.exec(
      `SELECT MIN(rowid) AS r FROM ${p.phase} WHERE rowid > ?`,
      p.cursor,
    ),
  ][0] as { r: number | null };
  if (startRow.r === null) {
    // Rows past the cursor were deleted (e.g. a webhook delivered).
    return { ...idle, next: { ...p, cursor: p.maxRowid } };
  }
  const from = startRow.r - 1;
  const to = from + width;
  const examined = processWindow(sql, p.phase, from, to);
  return { next: { ...p, cursor: to }, examined, from, to };
}

function maxRowid(
  sql: SqlStorage,
  table: MmrRangeMigrationPhase,
): number | null {
  const row = [...sql.exec(`SELECT MAX(rowid) AS r FROM ${table}`)][0] as {
    r: number | null;
  };
  return row.r;
}

/** Process the rows with rowid in `(from, to]`; returns how many there are. */
function processWindow(
  sql: SqlStorage,
  phase: MmrRangeMigrationPhase,
  from: number,
  to: number,
): number {
  const examined = Number(
    [
      ...sql.exec(
        `SELECT COUNT(*) AS n FROM ${phase} WHERE rowid > ? AND rowid <= ?`,
        from,
        to,
      ),
    ][0]!.n,
  );
  if (phase === "webhook_deliveries") {
    rewriteWebhookWindow(sql, from, to);
  } else {
    convertRangeWindow(sql, phase, from, to);
  }
  return examined;
}

/**
 * Convert one window of a range table. Bad rows are quarantined
 * (certificates) or deleted (pending) first; the rest convert in SQL. Rows
 * already be8 or NULL are left alone.
 */
function convertRangeWindow(
  sql: SqlStorage,
  table: "pending" | "delegation_certificates",
  from: number,
  to: number,
): void {
  const inWindow = `rowid > ? AND rowid <= ?`;
  const needs = `NOT (${be8OrNull("mmr_start")} AND ${be8OrNull("mmr_end")})`;
  const bad = `NOT (${convertibleOrDone("mmr_start")} AND ${convertibleOrDone("mmr_end")})`;
  if (table === "delegation_certificates") {
    quarantineBadCertificates(sql, `${inWindow} AND ${bad}`, from, to);
  } else {
    const dropped = [
      ...sql.exec(
        `SELECT id, ${reasonSql()} AS reason FROM pending
          WHERE ${inWindow} AND ${bad}`,
        from,
        to,
      ),
    ];
    for (const r of dropped) {
      console.error(
        `mmr range migration: pending "${String(r.id)}" deleted: ${String(r.reason)}`,
      );
    }
  }
  sql.exec(`DELETE FROM ${table} WHERE ${inWindow} AND ${bad}`, from, to);
  sql.exec(
    `UPDATE ${table}
        SET mmr_start = ${be8FromInteger("mmr_start")},
            mmr_end = ${be8FromInteger("mmr_end")}
      WHERE ${inWindow} AND ${needs}`,
    from,
    to,
  );
}

/**
 * Copy the window's bad certificate rows into the quarantine table (the
 * caller deletes them from the live table in the same transaction). Columns
 * are the quarantine table's own, so a live table grown by ALTERs in a
 * different column order still copies by name.
 */
function quarantineBadCertificates(
  sql: SqlStorage,
  where: string,
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
        WHERE ${where}
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
 * Rewrite the window's queued `delegation.required` payloads whose
 * `mmrStart` / `mmrEnd` are JSON numbers to canonical decimal strings, the
 * only shape receivers parse. One whose bounds are not a uint64 is deleted
 * with an error log — it cannot be delivered.
 */
function rewriteWebhookWindow(sql: SqlStorage, from: number, to: number): void {
  const numeric = (path: string) =>
    `json_type(payload_json, '${path}') IN ('integer', 'real')`;
  const rows = [
    ...sql.exec(
      `SELECT rowid AS rid, request_key, payload_json FROM webhook_deliveries
        WHERE rowid > ? AND rowid <= ?
          AND CASE WHEN json_valid(payload_json)
                   THEN ${numeric("$.mmrStart")} OR ${numeric("$.mmrEnd")}
                   ELSE 0 END`,
      from,
      to,
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
}

/**
 * Finish: drop rebuild-era leftovers, install the range triggers, delete the
 * progress record and set the done flag. One transaction, so the flag never
 * exists without the triggers and is the only residue.
 */
function completeMigration(sql: SqlStorage): void {
  for (const table of LEFTOVER_TABLES) {
    sql.exec(`DROP TABLE IF EXISTS ${table}`);
  }
  installMmrRangeTriggers(sql);
  sql.exec(`DELETE FROM schema_meta WHERE key = ?`, PROGRESS_KEY);
  sql.exec(
    `INSERT OR REPLACE INTO schema_meta (key, value) VALUES (?, ?)`,
    DONE_KEY,
    String(Math.floor(Date.now() / 1000)),
  );
}

/**
 * `BEFORE INSERT` / `BEFORE UPDATE` triggers that abort any write leaving a
 * range bound that is neither NULL nor an 8-byte BLOB. They make a rollback
 * to a build that binds numbers fail loudly.
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
