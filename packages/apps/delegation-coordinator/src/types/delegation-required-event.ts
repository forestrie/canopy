/** Outbound `delegation.required` webhook payload (v1). */
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
  materialSubmitUrl: string;
}
