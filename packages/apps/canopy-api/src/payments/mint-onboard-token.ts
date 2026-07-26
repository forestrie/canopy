import type {
  OnboardAdmittedBy,
  OnboardTokenChainBinding,
} from "./onboard-token-record.js";
import type { OnboardTokenRecord } from "./onboard-token-record.js";

export interface MintOnboardTokenOptions {
  label?: string;
  expiry?: number;
  requestId?: string;
  chainBinding?: OnboardTokenChainBinding;
  admittedBy?: OnboardAdmittedBy;
}

export interface MintOnboardTokenResult {
  token: string;
  record: OnboardTokenRecord;
}
