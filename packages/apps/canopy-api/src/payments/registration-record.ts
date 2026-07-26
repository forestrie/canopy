import type { OnboardAdmittedBy } from "./onboard-token-record.js";

/**
 * Legacy (pre-ADR-0059) registration class values, read-tolerated only:
 * existing `registration.json` objects still carry them (no data rewrite —
 * plan-2607-43 plan-level call). Never written since slice 02; this is the
 * one place the retired vocabulary may appear in code (naming-gate
 * allowlisted). Retire with a record backfill.
 */
type LegacyRegistrationClass = "payment-authoritative" | "regular";

/**
 * Co-located with genesis under `forests/forest/{R}/registration.json`.
 * `class` and `endorsedBy` are legacy fields (pre-ADR-0059): read-tolerated,
 * never written since plan-2607-43 slice 02.
 */
export interface RegistrationRecord {
  class?: LegacyRegistrationClass;
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
