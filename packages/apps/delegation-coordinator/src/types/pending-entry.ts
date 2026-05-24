/** Pending delegation hint awaiting material submission. */
export interface PendingEntry {
  id: string;
  authLogIdHex32: string;
  logIdHex32: string;
  mmrStart: number;
  mmrEnd: number;
  delegatedPublicKeyHash: string;
  requestedAt: number;
}
