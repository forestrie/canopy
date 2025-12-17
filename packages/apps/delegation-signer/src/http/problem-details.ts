import { encodeToCbor } from "../cbor/codec";

export const CBOR_MIME = "application/cbor";

function headersToRecord(
  init: HeadersInit | undefined,
): Record<string, string> {
  if (!init) return {};
  if (init instanceof Headers) {
    const out: Record<string, string> = {};
    init.forEach((value, key) => (out[key] = value));
    return out;
  }
  if (Array.isArray(init)) {
    const out: Record<string, string> = {};
    for (const [k, v] of init) out[k] = v;
    return out;
  }
  return { ...(init as Record<string, string>) };
}

export function cborResponse(
  data: unknown,
  status: number = 200,
  headersInit?: HeadersInit,
): Response {
  const encoded = encodeToCbor(data);
  const headers = headersToRecord(headersInit);

  if (!headers["content-type"]) headers["content-type"] = CBOR_MIME;
  headers["content-length"] = String(encoded.byteLength);
  if (!headers["cache-control"]) {
    headers["cache-control"] = status >= 400 ? "no-store" : "no-cache";
  }

  return new Response(encoded as unknown as BodyInit, {
    status,
    headers,
  });
}

function pd(
  status: number,
  title: string,
  detail?: string,
  headers?: HeadersInit,
): Response {
  const body: Record<string, unknown> = { type: "about:blank", title, status };
  if (detail) body.detail = detail;
  return cborResponse(body, status, headers);
}

export const ClientErrors = {
  badRequest: (detail?: string) => pd(400, "Bad Request", detail),
  unauthorized: (detail?: string, headers?: HeadersInit) =>
    pd(401, "Unauthorized", detail, headers),
  forbidden: (detail?: string) => pd(403, "Forbidden", detail),
  notFound: (detail?: string) => pd(404, "Not Found", detail),
  methodNotAllowed: (detail?: string) => pd(405, "Method Not Allowed", detail),
  unsupportedMediaType: (detail?: string) =>
    pd(415, "Unsupported Media Type", detail),
};

export const ServerErrors = {
  internal: (detail?: string) => pd(500, "Internal Server Error", detail),
  badGateway: (detail?: string) => pd(502, "Bad Gateway", detail),
};
