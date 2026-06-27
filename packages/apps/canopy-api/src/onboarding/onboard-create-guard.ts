import { ClientErrors } from "../cbor-api/problem-details.js";
import { getContentSize } from "../cbor-api/cbor-request.js";

export const ONBOARD_CREATE_BODY_MAX_BYTES = 16 * 1024;
export const ONBOARD_LABEL_MAX_LEN = 128;
export const ONBOARD_EMAIL_MAX_LEN = 320;
export const ONBOARD_ORIGIN_MAX_LEN = 512;
export const ONBOARD_REJECT_REASON_MAX_LEN = 512;

export interface OnboardCreateRateLimitEnv {
  ONBOARD_CREATE_RATE_LIMITER?: {
    limit(options: { key: string }): Promise<{ success: boolean }>;
  };
}

export async function checkOnboardCreateRateLimit(
  request: Request,
  env: OnboardCreateRateLimitEnv,
): Promise<Response | null> {
  const limiter = env.ONBOARD_CREATE_RATE_LIMITER;
  if (!limiter) return null;
  const ip = request.headers.get("CF-Connecting-IP")?.trim() || "unknown";
  const { success } = await limiter.limit({ key: ip });
  if (success) return null;
  return ClientErrors.tooManyRequests(
    "Onboard request rate limit exceeded; retry later",
  );
}

export function checkOnboardCreateBodySize(
  request: Request,
  bodyBytes: number,
): Response | null {
  const declared = getContentSize(request);
  if (
    typeof declared === "number" &&
    declared > ONBOARD_CREATE_BODY_MAX_BYTES
  ) {
    return ClientErrors.payloadTooLarge(
      declared,
      ONBOARD_CREATE_BODY_MAX_BYTES,
    );
  }
  if (bodyBytes > ONBOARD_CREATE_BODY_MAX_BYTES) {
    return ClientErrors.payloadTooLarge(
      bodyBytes,
      ONBOARD_CREATE_BODY_MAX_BYTES,
    );
  }
  return null;
}

export function checkOnboardFieldLengths(fields: {
  label?: string;
  contactEmail?: string;
  mandateOrigin?: string;
}): Response | null {
  if (fields.label && fields.label.length > ONBOARD_LABEL_MAX_LEN) {
    return ClientErrors.badRequest("label too long");
  }
  if (
    fields.contactEmail &&
    fields.contactEmail.length > ONBOARD_EMAIL_MAX_LEN
  ) {
    return ClientErrors.badRequest("contactEmail too long");
  }
  if (
    fields.mandateOrigin &&
    fields.mandateOrigin.length > ONBOARD_ORIGIN_MAX_LEN
  ) {
    return ClientErrors.badRequest("mandateOrigin too long");
  }
  return null;
}

export function checkOnboardRejectReasonLength(
  rejectReason: string | undefined,
): Response | null {
  if (rejectReason && rejectReason.length > ONBOARD_REJECT_REASON_MAX_LEN) {
    return ClientErrors.badRequest("rejectReason too long");
  }
  return null;
}
