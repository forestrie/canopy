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
  mmrStart: number;
  mmrEnd: number;
  delegatedPublicKeyHash: string;
  /** Base64-encoded delegated public key CBOR bytes. */
  delegatedPublicKey: string;
  requestedAt: number;
}
