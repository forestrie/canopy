import type { OnboardRequestStatus } from "./onboard-request-status.js";

export interface OnboardRequestChainBinding {
  chainId: string;
  univocityAddr: string;
}

/** Persisted onboard request (redeem code hash only). */
export interface OnboardRequestRecord {
  requestId: string;
  status: OnboardRequestStatus;
  label: string;
  chainBinding: OnboardRequestChainBinding;
  contactEmail: string;
  mandateOrigin?: string;
  plannedForestR?: string;
  redeemCodeHash: string;
  createdAt: number;
  expiresAt: number;
  onboardTokenRef?: string;
  rejectReason?: string;
  redeemedAt?: number;
  /** Approved by the dev auto-approve path, not an operator (ADR-0059 D3/F6). */
  autoApproved?: boolean;
}
