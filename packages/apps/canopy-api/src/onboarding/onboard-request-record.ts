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
  /**
   * Key of the single-use claim marker (`payments/used-attestations/…`)
   * that create wrote for this request's bootstrap-key attestation
   * (plan-2611-11 Q48; onboard-attestation-claim.ts). Set only once the
   * claim wins, and never changed. A record without it was created before
   * this deploy (before single-use claims) and is forfeit (Q49): it is
   * never approved, redeemed or reissued, and never counts toward the
   * pending cap.
   * See {@link hasAttestationClaim}.
   */
  attestationClaimKey?: string;
}
