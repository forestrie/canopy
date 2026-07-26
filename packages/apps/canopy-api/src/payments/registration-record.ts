import type { RegistrationClass } from "./registration-class.js";
import type { OnboardAdmittedBy } from "./onboard-token-record.js";

/** Co-located with genesis under `forests/forest/{R}/registration.json`. */
export interface RegistrationRecord {
  class: RegistrationClass;
  onboardTokenRef?: string;
  endorsedBy?: string;
  chainBinding: {
    chainId: string;
    univocityAddr: string;
  };
  createdAt: number;
  /** Which gate admitted this account: ops approval or x402 payment (ADR-0059). */
  admittedBy?: OnboardAdmittedBy;
}
