import type { OnboardTokenStatus } from "./onboard-token-status.js";

export interface OnboardTokenChainBinding {
  chainId: string;
  univocityAddr: string;
}

/**
 * Which gate admitted the holder: an operator's approval (including
 * break-glass mint), x402 payment substituting for approval, or the dev
 * auto-approve path — kept distinct so "ops" always means a person acted
 * (ADR-0059 decision 3; plan-2607-02 F6).
 */
export type OnboardAdmittedBy = "ops" | "payment" | "auto";

/** Persisted onboard-token metadata (token value is never stored). */
export interface OnboardTokenRecord {
  hash: string;
  label?: string;
  createdAt: number;
  expiry?: number;
  status: OnboardTokenStatus;
  requestId?: string;
  chainBinding?: OnboardTokenChainBinding;
  consumedForestR?: string;
  admittedBy?: OnboardAdmittedBy;
}
