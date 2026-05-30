/** Pending delegation hint awaiting material submission. */
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
