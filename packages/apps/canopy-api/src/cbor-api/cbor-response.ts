import { encodeCborDeterministic } from "@forestrie/encoding";

import { CACHE_CONTROL_NO_STORE } from "./cache-policy.js";
import { CBOR_MIME } from "./cbor-const.js";
import { CBOR_CONTENT_TYPES } from "./cbor-content-types.js";
import { convertHeaders } from "./cbor-request.js";

export function cborResponse(
  data: unknown,
  status = 200,
  contentTypeOrHeaders?: string | HeadersInit,
): Response {
  const encoded = encodeCborDeterministic(data);

  // Determine headers
  let headers: Record<string, string>;
  if (typeof contentTypeOrHeaders === "string") {
    // contentTypeOrHeaders is a content-type string
    headers = { "content-type": contentTypeOrHeaders };
  } else if (contentTypeOrHeaders) {
    // contentTypeOrHeaders is a HeadersInit object
    headers = {
      "content-type": CBOR_MIME,
      ...convertHeaders(contentTypeOrHeaders),
    };
  } else {
    headers = { "content-type": CBOR_MIME };
  }

  // Add Content-Length
  headers["content-length"] = String(encoded.byteLength);

  // Cache-Control defaults to no-store (ADR-0057). Immutability is a claim a
  // handler makes deliberately by passing an explicit cache-control header —
  // it must never be inherited. This default previously stamped every 2xx CBOR
  // response `immutable, max-age=31536000`, which pinned mutable state such as
  // token lists and revocation status for a year, and pinned receipts assembled
  // from a still-open massif so they could never be freshened.
  if (!headers["cache-control"]) {
    headers["cache-control"] = CACHE_CONTROL_NO_STORE;
  }

  return new Response(encoded as unknown as BodyInit, {
    status,
    headers,
  });
}

/**
 * A Concise Problem Details document (RFC 9290), served as
 * `application/problem+cbor` — the media type `docs/api/canopy-api.md`
 * specifies and the one `@forestrie/scrapi-client`'s decoder gates on.
 * Until FOR-559's follow-up (devdocs plan-2609-08 phase 3) every problem
 * body went out as plain `application/cbor`, so strict clients showed
 * callers the raw CBOR bytes instead of `title`/`detail`.
 *
 * `type` is a problem-type URI (`about:blank` when there is none). The
 * human-readable message belongs in `opts.detail`, never in `type`: a
 * client that reads `detail` and shows `type` as a link would otherwise
 * lose the message. Callers that need extra headers (CORS) pass them as
 * `opts.headers`; a bare headers object in the fourth position is not
 * read.
 */
export function problemResponse(
  status: number,
  title: string,
  type = "about:blank",
  opts: {
    detail?: string;
    instance?: string;
    headers?: HeadersInit;
  } = {},
): Response {
  const body: Record<string, unknown> = { type, title, status };

  const { instance, headers, detail } = opts;

  if (detail) body.detail = detail;
  if (instance) body.instance = instance;
  return problemCborResponse(body, status, headers);
}

/** `cborResponse` with the problem-details media type, whatever other
 *  headers the caller adds. */
export function problemCborResponse(
  body: Record<string, unknown>,
  status: number,
  headers?: HeadersInit,
): Response {
  return cborResponse(body, status, {
    ...(headers !== undefined ? convertHeaders(headers) : {}),
    "content-type": CBOR_CONTENT_TYPES.PROBLEM_CBOR,
  });
}

export function requireAcceptCbor(request: Request): Response | null {
  const accept = request.headers.get("accept");
  if (!accept) return null;
  const acceptable = accept
    .split(",")
    .some(
      (v) => v.trim().toLowerCase().startsWith(CBOR_MIME) || v.includes("*/*"),
    );
  return acceptable
    ? null
    : problemResponse(406, "Not Acceptable", "about:blank", {
        detail: "Only application/cbor is supported",
      });
}

export function requireContentTypeCbor(request: Request): Response | null {
  const contentType = (request.headers.get("content-type") || "").toLowerCase();
  if (!contentType.startsWith(CBOR_MIME)) {
    return problemResponse(415, "Unsupported Media Type", "about:blank", {
      detail: "Use application/cbor",
    });
  }
  return null;
}

/**
 * Return 202 Accepted response with operation location
 */
export function acceptedResponse(
  operationId: string,
  location: string,
  data?: Record<string, unknown>,
): Response {
  return cborResponse(data || { operationId }, 202, {
    Location: location,
  });
}

/**
 * Return 303 See Other (e.g. async registration: client polls `Location`).
 */
export function seeOtherResponse(
  location: string,
  retryAfter?: number,
): Response {
  const headers: Record<string, string> = {
    Location: location,
    "Content-Length": "0",
  };

  if (retryAfter) {
    headers["Retry-After"] = String(retryAfter);
  }

  return new Response(null, {
    status: 303,
    headers,
  });
}

/**
 * Return 304 Not Modified response
 */
export function notModifiedResponse(etag: string): Response {
  return new Response(null, {
    status: 304,
    headers: {
      ETag: etag,
    },
  });
}

/**
 * Generate ETag from content
 */
export async function generateETag(content: Uint8Array): Promise<string> {
  const hashBuffer = await crypto.subtle.digest(
    "MD5",
    content.buffer as ArrayBuffer,
  );
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}
