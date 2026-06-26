import type { OnboardTokenStatus } from "./onboard-token-status.js";

export interface OnboardTokenChainBinding {
  chainId: string;
  univocityAddr: string;
}

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
}
