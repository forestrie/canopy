/** JSON body for POST pending hint (DO internal and worker). */
export interface PendingHintRequest {
  authLogId: string;
  logId: string;
  mmrStart: number;
  mmrEnd: number;
  /** Base64-encoded delegated public key CBOR bytes */
  delegatedPublicKey: string;
}
