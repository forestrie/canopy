/**
 * Pending hint insertion request (internal DO and worker).
 *
 * Records operator-visible pending rows without going through issue flow.
 */

/** JSON body for POST /pending-hint on DelegationStoreDO. */
export interface PendingHintRequest {
  authLogId: string;
  logId: string;
  mmrStart: number;
  mmrEnd: number;
  /** Base64-encoded delegated public key CBOR bytes. */
  delegatedPublicKey: string;
}
