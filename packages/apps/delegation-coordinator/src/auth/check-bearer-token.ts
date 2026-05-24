/**
 * Bearer token check (constant-time compare).
 *
 * @returns `null` when authorized, otherwise a **401** JSON problem `Response`.
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

function unauthorized(detail: string): Response {
  return problemResponse(401, "about:blank", "Unauthorized", detail);
}

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
