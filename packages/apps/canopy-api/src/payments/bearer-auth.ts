/**
 * Constant-time Bearer token check for ops/admin routes.
 */

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
  if (!expectedTokenTrimmed) {
    return ClientErrors.unauthorized(messages.missing);
  }
  const auth = request.headers.get("Authorization")?.trim() ?? "";
  const m = /^Bearer\s+(.+)$/i.exec(auth);
  if (!m) {
    return ClientErrors.unauthorized(messages.missing);
  }
  const presented = m[1]!.trim();
  if (presented.length !== expectedTokenTrimmed.length) {
    return ClientErrors.unauthorized(messages.invalid);
  }
  const a = new TextEncoder().encode(presented);
  const b = new TextEncoder().encode(expectedTokenTrimmed);
  if (a.byteLength !== b.byteLength) {
    return ClientErrors.unauthorized(messages.invalid);
  }
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a[i]! ^ b[i]!;
  }
  return diff === 0
    ? null
    : ClientErrors.unauthorized(messages.invalid);
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
