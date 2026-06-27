import type { OnboardRequestRecord } from "./onboard-request-record.js";

export interface OnboardRequestWithEtag {
  record: OnboardRequestRecord;
  etag: string;
}
