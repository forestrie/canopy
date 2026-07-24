/**
 * Cache policy for canopy responses (FOR-302, ADR-0057).
 *
 * The default is `no-store`. Immutability is a claim a handler makes
 * deliberately, never something it inherits: the previous default stamped every
 * 2xx CBOR response `public, max-age=31536000, immutable`, which pinned mutable
 * state — payment token lists, revocation status — for a year, and pinned
 * assembled receipts so they could never be freshened (FOR-418).
 *
 * Only genesis is immutable, because it is written once and never rewritten.
 *
 * Receipts are deliberately NOT immutable, even when the massif holding the
 * entry is complete. A receipt is derived from the massif *and* the latest
 * checkpoint for it, and completeness freezes only the massif. The sealer
 * resumes from `HeadIndex(ObjectCheckpoint)` and re-seals that massif
 * (`sealer.go`: `for mi := startMassifIndex; mi <= headMassifIndex; mi++`, with
 * an explicit same-massif re-seal case), so a complete massif's checkpoint can
 * still be replaced — ADR-0056 records checkpoints as "stored one per massif
 * index and overwritten on re-seal", and only each massif's *final* retained
 * checkpoint is durably addressable. Caching a receipt immutably would pin a
 * superseded proof for a year.
 */

/** Content that can never legitimately change again. Genesis only. */
export const CACHE_CONTROL_IMMUTABLE = "public, max-age=31536000, immutable";

/** Everything else, including every error response. */
export const CACHE_CONTROL_NO_STORE = "no-store";

export const IMMUTABLE_HEADERS = {
  "cache-control": CACHE_CONTROL_IMMUTABLE,
} as const;

export const NO_STORE_HEADERS = {
  "cache-control": CACHE_CONTROL_NO_STORE,
} as const;
