import type { RegistrationClass } from "./registration-class.js";

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
}
