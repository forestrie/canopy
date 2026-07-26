import type { RegistrationClass } from "./registration-class.js";
import type { OnboardAdmittedBy } from "./onboard-token-record.js";

/**
 * Co-located with genesis under `forests/forest/{R}/registration.json`.
 * `class` and `endorsedBy` are legacy fields (pre-ADR-0059): read-tolerated,
 * never written since plan-2607-43 slice 02.
 */
export interface RegistrationRecord {
  class?: RegistrationClass;
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
