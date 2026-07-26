import type { OnboardTokenStatus } from "./onboard-token-status.js";

export interface OnboardTokenChainBinding {
  chainId: string;
  univocityAddr: string;
}

/**
 * Which gate admitted the holder: ops approval (including break-glass mint)
 * or x402 payment substituting for approval (ADR-0059 decision 3).
 */
export type OnboardAdmittedBy = "ops" | "payment";

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
