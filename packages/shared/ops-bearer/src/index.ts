/**
 * Constant-time Bearer token comparison, response-shape-agnostic.
 *
 * The core of every ops/admin gate in the workers: canopy-api maps the
 * outcome to CBOR problem responses, x402-settlement to JSON. Promoted from
 * canopy-api's payments/bearer-auth (plan-2607-43 slice 03) so a second
 * worker gaining an admin surface cannot re-implement the compare loosely.
 */

export type BearerCheckOutcome = "ok" | "missing" | "invalid";

/**
 * @param expectedTokenTrimmed - The configured token, already trimmed. An
 *   empty value is `missing` — an unset secret must fail closed, never open.
 */
export function checkBearer(
  request: Request,
  expectedTokenTrimmed: string,
): BearerCheckOutcome {
  if (!expectedTokenTrimmed) return "missing";
  const auth = request.headers.get("Authorization")?.trim() ?? "";
  const m = /^Bearer\s+(.+)$/i.exec(auth);
  if (!m) return "missing";
  const presented = m[1]!.trim();
  if (presented.length !== expectedTokenTrimmed.length) return "invalid";
  const a = new TextEncoder().encode(presented);
  const b = new TextEncoder().encode(expectedTokenTrimmed);
  if (a.byteLength !== b.byteLength) return "invalid";
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a[i]! ^ b[i]!;
  }
  return diff === 0 ? "ok" : "invalid";
}
