/**
 * JSON body of GET /api/logs/{logId}/delegation — the log's current
 * certificate (newest unexpired, widest range on ties).
 *
 * Signers read `expiresAt` / `mmrEnd` to anticipate renewal; the range bounds
 * are canonical decimal uint64 strings, never JSON numbers.
 */

/** Current delegation certificate for one log. */
export interface CurrentDelegationResponse {
  logId: string;
  /** Base64 delegation certificate COSE Sign1 bytes. */
  certificate: string;
  /** Range start (inclusive), canonical decimal uint64 string. */
  mmrStart: string;
  /** Range end (inclusive), canonical decimal uint64 string. */
  mmrEnd: string;
  /** Base64 delegated public key CBOR bytes, or null on a legacy row. */
  delegatedPublicKey: string | null;
  issuedAt: number;
  expiresAt: number;
}
