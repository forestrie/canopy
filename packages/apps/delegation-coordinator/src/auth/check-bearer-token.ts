/**
 * Bearer token authorization with constant-time comparison.
 *
 * Used by operator routes and legacy app-token fallbacks when wallet-challenge
 * sessions are disabled. Returns RFC 7807 JSON problems on failure.
 */

/**
 * Verify `Authorization: Bearer` against one or more configured tokens.
 *
 * @param request - Incoming HTTP request.
 * @param expectedTokens - Candidate secrets (trimmed; empty entries ignored).
 * @returns `null` when authorized, otherwise a **401** JSON problem Response.
 */
export function checkBearerToken(
  request: Request,
  ...expectedTokens: (string | undefined)[]
): Response | null {
  const configured = expectedTokens
    .map((t) => t?.trim())
    .filter((t): t is string => Boolean(t));

  if (configured.length === 0) {
    return unauthorized("Coordinator auth is not configured");
  }

  const auth = request.headers.get("Authorization")?.trim() ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(auth);
  if (!match) {
    return unauthorized("Authorization: Bearer token required");
  }

  const presented = match[1]!.trim();
  for (const expected of configured) {
    if (constantTimeEqual(presented, expected)) {
      return null;
    }
  }

  return unauthorized("Invalid bearer token");
}

/** Build a 401 Unauthorized problem response. */
function unauthorized(detail: string): Response {
  return problemResponse(401, "about:blank", "Unauthorized", detail);
}

/** Minimal RFC 7807 JSON problem builder (local to avoid import cycle). */
function problemResponse(
  status: number,
  type: string,
  title: string,
  detail?: string,
): Response {
  return Response.json(
    { type, title, status, detail },
    {
      status,
      headers: { "Content-Type": "application/problem+json" },
    },
  );
}

/**
 * Constant-time string equality for bearer token comparison.
 *
 * @param a - Presented token.
 * @param b - Expected token.
 * @returns True when byte lengths and contents match.
 */
function constantTimeEqual(a: string, b: string): boolean {
  const encA = new TextEncoder().encode(a);
  const encB = new TextEncoder().encode(b);
  if (encA.byteLength !== encB.byteLength) {
    return false;
  }
  let diff = 0;
  for (let i = 0; i < encA.length; i++) {
    diff |= encA[i]! ^ encB[i]!;
  }
  return diff === 0;
}
