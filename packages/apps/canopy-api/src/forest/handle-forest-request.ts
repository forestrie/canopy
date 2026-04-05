/**
 * `/api/forest/**` dispatcher (Plan 0018). POST genesis requires curator bearer; GET genesis is public.
 */

import { problemResponse } from "../cbor-api/cbor-response.js";
import { ClientErrors } from "../cbor-api/problem-details.js";
import { curatorAdminBearerOrUnauthorized } from "./curator-admin-bearer.js";
import { getForestGenesis } from "./get-forest-genesis.js";
import { postForestGenesis, type PostGenesisEnv } from "./post-genesis.js";

export interface ForestHandlerEnv extends PostGenesisEnv {
  CURATOR_ADMIN_TOKEN?: string;
}

function attachCors(
  res: Response,
  corsHeaders: Record<string, string>,
): Response {
  const headers = new Headers(res.headers);
  for (const [k, v] of Object.entries(corsHeaders)) {
    headers.set(k, v);
  }
  return new Response(res.body, {
    status: res.status,
    statusText: res.statusText,
    headers,
  });
}

/**
 * @returns a `Response` for any `/api/forest` or `/api/forest/**` path, else `null`.
 */
export async function handleForestRequest(
  request: Request,
  pathname: string,
  env: ForestHandlerEnv,
  corsHeaders: Record<string, string>,
): Promise<Response | null> {
  if (pathname !== "/api/forest" && !pathname.startsWith("/api/forest/")) {
    return null;
  }

  if (pathname === "/api/forest") {
    const token = env.CURATOR_ADMIN_TOKEN?.trim() ?? "";
    const authErr = curatorAdminBearerOrUnauthorized(request, token);
    if (authErr) return attachCors(authErr, corsHeaders);
    return attachCors(
      ClientErrors.notFound(
        "Not Found",
        "No resource at /api/forest (use /api/forest/{log-id}/genesis)",
      ),
      corsHeaders,
    );
  }

  const rest = pathname.slice("/api/forest/".length);
  const parts = rest.split("/").filter(Boolean);

  if (parts.length === 2 && parts[1] === "genesis") {
    const logIdSeg = parts[0]!;
    if (request.method === "GET") {
      const res = await getForestGenesis(logIdSeg, env);
      return attachCors(res, corsHeaders);
    }
    if (request.method === "POST") {
      const token = env.CURATOR_ADMIN_TOKEN?.trim() ?? "";
      const authErr = curatorAdminBearerOrUnauthorized(request, token);
      if (authErr) return attachCors(authErr, corsHeaders);
      const res = await postForestGenesis(request, logIdSeg, env);
      return attachCors(res, corsHeaders);
    }
    return attachCors(
      problemResponse(405, "Method Not Allowed", "about:blank", {
        detail: `Method ${request.method} not allowed for ${pathname}`,
      }),
      corsHeaders,
    );
  }

  const token = env.CURATOR_ADMIN_TOKEN?.trim() ?? "";
  const authErr = curatorAdminBearerOrUnauthorized(request, token);
  if (authErr) return attachCors(authErr, corsHeaders);

  return attachCors(
    problemResponse(404, "Not Found", "about:blank", {
      detail: `Unknown forest route ${pathname}`,
    }),
    corsHeaders,
  );
}
