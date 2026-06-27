import type { OnboardRequestRecord } from "./onboard-request-record.js";

export interface ListOnboardRequestsResult {
  requests: OnboardRequestRecord[];
  cursor?: string;
}
