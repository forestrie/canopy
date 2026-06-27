import type { OnboardRequestRecord } from "./onboard-request-record.js";

export interface CreateOnboardRequestInput {
  label: string;
  chainBinding: OnboardRequestRecord["chainBinding"];
  contactEmail: string;
  mandateOrigin?: string;
  plannedForestR?: string;
  ttlSec: number;
}

export interface CreateOnboardRequestResult {
  record: OnboardRequestRecord;
  redeemCode: string;
}
