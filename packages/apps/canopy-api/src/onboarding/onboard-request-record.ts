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
  /** Plaintext minted token; cleared after redeem. */
  approvedToken?: string;
  rejectReason?: string;
  redeemedAt?: number;
}
