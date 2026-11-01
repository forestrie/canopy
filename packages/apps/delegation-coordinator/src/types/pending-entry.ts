/**
 * Pending delegation hint exposed to operators and sealer polling.
 *
 * Surfaced via GET /api/delegations/pending and per-log pending-delegation
 * when delegation is enabled; cleared on certificate PUT.
 */

/** Pending delegation awaiting runner certificate submission. */
export interface PendingEntry {
  id: string;
  authLogIdHex32: string;
  logIdHex32: string;
  /** Range start, canonical decimal uint64 string (plan-2611-01 D1). */
  mmrStart: string;
  /** Range end, canonical decimal uint64 string (plan-2611-01 D1). */
  mmrEnd: string;
  delegatedPublicKeyHash: string;
  /** Base64-encoded delegated public key CBOR bytes. */
  delegatedPublicKey: string;
  requestedAt: number;
}
