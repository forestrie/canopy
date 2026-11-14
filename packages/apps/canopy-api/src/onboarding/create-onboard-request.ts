import type { OnboardRequestRecord } from "./onboard-request-record.js";

export interface CreateOnboardRequestInput {
  label: string;
  chainBinding: OnboardRequestRecord["chainBinding"];
  contactEmail: string;
  mandateOrigin?: string;
  plannedForestR?: string;
  ttlSec: number;
  /**
   * Marker key returned by the winning `claimOnboardAttestation`; see
   * OnboardRequestRecord.attestationClaimKey.
   */
  attestationClaimKey: string;
}

export interface CreateOnboardRequestResult {
  record: OnboardRequestRecord;
  redeemCode: string;
}
