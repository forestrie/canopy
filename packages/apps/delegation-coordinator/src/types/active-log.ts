/**
 * Per-log row of GET /api/delegations/active, the sealer's level-triggered
 * resync feed (arbor plan-2607-04).
 *
 * The range bounds are canonical decimal uint64 strings, never JSON numbers:
 * arbor's sealer resync parses them with `strconv.ParseUint(s, 10, 64)` and
 * treats a JSON number as malformed
 * ([resync.go](https://github.com/forestrie/arbor/blob/main/services/sealer/src/resync.go)).
 */

/** Per-log active-delegation summary returned to the sealer resync. */
export interface ActiveLog {
  logIdHex32: string;
  /** Furthest cert expiry for this log (epoch seconds). */
  expiresAt: number;
  /** Lowest authorized mmr start across this log's certs, or null if unknown. */
  mmrStart: string | null;
  /**
   * Highest authorized mmr end across this log's certs, or null if unknown.
   * The sealer resync uses this to hint how far the log should be sealed.
   */
  mmrEnd: string | null;
}
