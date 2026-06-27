/**
 * JSON problem responses for browser ops admin routes (RFC 7807-style).
 */

import { decode as decodeCbor } from "cbor-x";

export interface AdminJsonProblemBody {
  type: string;
  title: string;
  status: number;
  detail?: string;
}

const NO_STORE = { "cache-control": "no-store" };

export function adminJsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...NO_STORE,
    },
  });
}

export function adminJsonProblem(
  status: number,
  title: string,
  detail?: string,
  type = "about:blank",
): Response {
  const body: AdminJsonProblemBody = { type, title, status };
  if (detail) body.detail = detail;
  return adminJsonResponse(body, status);
}

export const AdminJsonErrors = {
  unauthorized: (detail: string) =>
    adminJsonProblem(401, "Unauthorized", detail),
  notFound: (detail: string) => adminJsonProblem(404, "Not Found", detail),
  conflict: (detail: string) => adminJsonProblem(409, "Conflict", detail),
  badRequest: (detail: string) => adminJsonProblem(400, "Bad Request", detail),
  serviceUnavailable: (detail: string) =>
    adminJsonProblem(503, "Service Unavailable", detail),
};

export async function problemResponseToAdminJson(
  res: Response,
): Promise<Response> {
  const ct = res.headers.get("content-type") ?? "";
  if (ct.includes("application/json")) {
    return res;
  }
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.byteLength === 0) {
    return adminJsonProblem(res.status, res.statusText || "Error");
  }
  try {
    const body = decodeCbor(bytes) as {
      status?: number;
      title?: string;
      detail?: string;
      type?: string;
    };
    return adminJsonProblem(
      typeof body.status === "number" ? body.status : res.status,
      typeof body.title === "string" ? body.title : res.statusText || "Error",
      typeof body.detail === "string" ? body.detail : undefined,
      typeof body.type === "string" ? body.type : "about:blank",
    );
  } catch {
    return adminJsonProblem(res.status, res.statusText || "Error");
  }
}

export async function asAdminJsonResponse(
  res: Response,
  useJson: boolean,
): Promise<Response> {
  if (!useJson) return res;
  if (res.ok) return res;
  return problemResponseToAdminJson(res);
}
