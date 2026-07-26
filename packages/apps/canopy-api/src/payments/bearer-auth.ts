/**
 * Constant-time Bearer token check for ops/admin routes.
 */

import { checkBearer } from "@canopy/ops-bearer";
import { ClientErrors } from "../cbor-api/problem-details.js";

export interface BearerAuthMessages {
  missing: string;
  invalid: string;
}

const DEFAULT_MESSAGES: BearerAuthMessages = {
  missing: "Authorization: Bearer <token> required",
  invalid: "Invalid bearer token",
};

/**
 * @returns `null` if authorized, otherwise a **401** CBOR problem `Response`.
 */
export function bearerTokenOrUnauthorized(
  request: Request,
  expectedTokenTrimmed: string,
  messages: BearerAuthMessages = DEFAULT_MESSAGES,
): Response | null {
  const outcome = checkBearer(request, expectedTokenTrimmed);
  if (outcome === "ok") return null;
  return ClientErrors.unauthorized(
    outcome === "missing" ? messages.missing : messages.invalid,
  );
}

/** Ops admin bearer for onboard-token mint/list/revoke. */
export function opsAdminBearerOrUnauthorized(
  request: Request,
  expectedTokenTrimmed: string,
): Response | null {
  return bearerTokenOrUnauthorized(request, expectedTokenTrimmed, {
    missing: "Authorization: Bearer <CANOPY_OPS_ADMIN_TOKEN> required",
    invalid: "Invalid ops admin token",
  });
}
