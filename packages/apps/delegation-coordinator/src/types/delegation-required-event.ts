/**
 * Outbound `delegation.required` webhook event shape (v1).
 *
 * Produced by {@link buildDelegationRequiredEvent} when
 * {@link DelegationStoreDO} records a pending BYOK certificate request.
 */

/** Signed webhook payload notifying operators to submit delegation material. */
export interface DelegationRequiredEvent {
  requestKey: string;
  type: "delegation.required";
  version: 1;
  logId: string;
  authLogId: string;
  mmrStart: number;
  mmrEnd: number;
  delegatedPublicKey: string;
  requestedAt: number;
  certificateSubmitUrl: string;
  /** @deprecated use certificateSubmitUrl */
  materialSubmitUrl?: string;
}
