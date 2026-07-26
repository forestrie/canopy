import type {
  OnboardAdmittedBy,
  OnboardTokenChainBinding,
} from "./onboard-token-record.js";
import type { OnboardTokenRecord } from "./onboard-token-record.js";

export interface MintOnboardTokenOptions {
  label?: string;
  expiry?: number;
  requestId?: string;
  /**
   * Mandatory (ADR-0059 decision 8): every token is scoped to one instance.
   * Tokens minted before this rule (lane-A legacy) may lack it at rest;
   * genesis tolerates those via the direct-claim fallback.
   */
  chainBinding: OnboardTokenChainBinding;
  admittedBy?: OnboardAdmittedBy;
}

export interface MintOnboardTokenResult {
  token: string;
  record: OnboardTokenRecord;
}
