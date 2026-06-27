import type { OnboardTokenChainBinding } from "./onboard-token-record.js";
import type { OnboardTokenRecord } from "./onboard-token-record.js";

export interface MintOnboardTokenOptions {
  label?: string;
  expiry?: number;
  requestId?: string;
  chainBinding?: OnboardTokenChainBinding;
}

export interface MintOnboardTokenResult {
  token: string;
  record: OnboardTokenRecord;
}
