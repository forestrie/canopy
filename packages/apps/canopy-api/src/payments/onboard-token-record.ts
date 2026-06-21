import type { OnboardTokenStatus } from "./onboard-token-status.js";

/** Persisted onboard-token metadata (token value is never stored). */
export interface OnboardTokenRecord {
  hash: string;
  label?: string;
  createdAt: number;
  expiry?: number;
  status: OnboardTokenStatus;
}
