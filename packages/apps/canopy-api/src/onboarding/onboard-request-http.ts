import { ClientErrors } from "../cbor-api/problem-details.js";
import { problemResponse } from "../cbor-api/cbor-response.js";
import type { OnboardRequestRecord } from "./onboard-request-record.js";
import { effectiveStatus } from "./onboard-request-store.js";

export type OnboardRequestHttpError =
  | { kind: "none" }
  | { kind: "response"; response: Response };

/** Shared redeem/status gate for onboard request lifecycle. */
export function redeemOrStatusHttpError(
  record: OnboardRequestRecord,
): OnboardRequestHttpError {
  const status = effectiveStatus(record);
  if (status === "expired") {
    return {
      kind: "response",
      response: problemResponse(410, "Gone", "about:blank", {
        detail: "Request expired",
      }),
    };
  }
  if (status === "redeemed") {
    return {
      kind: "response",
      response: ClientErrors.conflict("Request already redeemed"),
    };
  }
  if (status === "rejected") {
    return {
      kind: "response",
      response: ClientErrors.conflict("Request was rejected"),
    };
  }
  if (status === "pending") {
    return {
      kind: "response",
      response: ClientErrors.conflict("Request not approved"),
    };
  }
  if (status !== "approved") {
    return {
      kind: "response",
      response: ClientErrors.conflict("Request not approved"),
    };
  }
  return { kind: "none" };
}
