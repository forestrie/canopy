import type { OnboardRequestRecord } from "./onboard-request-record.js";

export interface CreateOnboardRequestInput {
  label: string;
  chainBinding: OnboardRequestRecord["chainBinding"];
  contactEmail: string;
  mandateOrigin?: string;
  plannedForestR?: string;
  ttlSec: number;
  /** A valid bootstrap-key attestation accompanied the request (slice 06). */
  attested?: boolean;
}

export interface CreateOnboardRequestResult {
  record: OnboardRequestRecord;
  redeemCode: string;
}
