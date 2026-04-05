/**
 * Bearer check for `CURATOR_ADMIN_TOKEN` (Authorization: Bearer …).
 */

import { ClientErrors } from "../cbor-api/problem-details.js";

/**
 * @returns `null` if authorized, otherwise a **401** CBOR problem `Response`.
 */
export function curatorAdminBearerOrUnauthorized(
  request: Request,
  expectedTokenTrimmed: string,
): Response | null {
  const auth = request.headers.get("Authorization")?.trim() ?? "";
  const m = /^Bearer\s+(.+)$/i.exec(auth);
  if (!m) {
    return ClientErrors.unauthorized(
      "Authorization: Bearer <CURATOR_ADMIN_TOKEN> required",
    );
  }
  const presented = m[1]!.trim();
  if (presented.length !== expectedTokenTrimmed.length) {
    return ClientErrors.unauthorized("Invalid curator admin token");
  }
  const a = new TextEncoder().encode(presented);
  const b = new TextEncoder().encode(expectedTokenTrimmed);
  if (a.byteLength !== b.byteLength) {
    return ClientErrors.unauthorized("Invalid curator admin token");
  }
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a[i]! ^ b[i]!;
  }
  return diff === 0
    ? null
    : ClientErrors.unauthorized("Invalid curator admin token");
}
