/**
 * One structured log line per problem response (FOR-579).
 *
 * A worker that answers a request with a 4xx or 5xx says so in its own logs:
 * method, route pattern, status, the problem's title and detail, and the
 * `cf-ray` of the request, on one JSON line. The response body is not
 * changed. Until this existed a rejected request left no trace on the
 * server side, so a client that also dropped the detail (the published
 * mandate-register kit, see plan-2609-10 slice 06 step A10) produced an
 * outage that took four qualification runs to explain.
 *
 * `logProblemResponse` is applied once per worker at the edge of its `fetch`
 * handler, so every builder of a problem response is covered: the shared
 * `problemResponse` / `ClientErrors` helpers, the ad hoc problem bodies in
 * Durable Objects relayed by the worker, and the framework's own 500 path.
 */
import { decodeCborDeterministic } from "@forestrie/encoding";

/** The record written as one JSON line. */
export interface ProblemLogEntry {
  event: "problem_response";
  /** `warn` for 4xx, `error` for 5xx. */
  level: "warn" | "error";
  /** Worker name, so lines from different workers can be told apart. */
  service?: string;
  method: string;
  /** Request path as received. */
  path: string;
  /** Path with identifier-like segments replaced by `{id}`. */
  route: string;
  status: number;
  /** Problem-details fields when the body carries them. */
  type?: string;
  title?: string;
  detail?: string;
  /** Cloudflare request id (`cf-ray`), when the request came through Cloudflare. */
  ray?: string;
}

/** Writer for the two levels used; `console` by default. */
export type ProblemLogger = Pick<Console, "warn" | "error">;

export interface LogProblemResponseOptions {
  service?: string;
  /** Route pattern when the caller knows it; otherwise derived from the path. */
  route?: string;
  /** Override for tests. */
  log?: ProblemLogger;
}

/** Longest `detail` written; problem bodies are short, this is a guard. */
export const MAX_DETAIL_LENGTH = 512;

const HEX_ID = /^(0x)?[0-9a-f]{32,64}$/i;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CAIP_INSTANCE = /^eip155:\d+:0x[0-9a-f]{40}$/i;
const NUMERIC = /^\d+$/;
const LONG_TOKEN = /^[A-Za-z0-9_-]{24,}$/;

function isIdLike(segment: string): boolean {
  return (
    HEX_ID.test(segment) ||
    UUID.test(segment) ||
    CAIP_INSTANCE.test(segment) ||
    NUMERIC.test(segment) ||
    LONG_TOKEN.test(segment)
  );
}

/**
 * Reduce a request path to a route pattern by replacing identifier-like
 * segments (hex ids, UUIDs, chain-scoped instance ids, numbers, opaque
 * tokens) with `{id}`, so lines group by route rather than by resource.
 */
export function routePattern(pathname: string): string {
  return pathname
    .split("/")
    .map((segment) => (isIdLike(segment) ? "{id}" : segment))
    .join("/");
}

type ProblemFields = Pick<ProblemLogEntry, "type" | "title" | "detail">;

function readString(
  source: Map<unknown, unknown> | Record<string, unknown>,
  key: string,
): string | undefined {
  const value =
    source instanceof Map
      ? source.get(key)
      : (source as Record<string, unknown>)[key];
  return typeof value === "string" ? value : undefined;
}

function pickProblemFields(decoded: unknown): ProblemFields {
  if (
    decoded instanceof Map ||
    (typeof decoded === "object" && decoded !== null)
  ) {
    const source = decoded as Map<unknown, unknown> | Record<string, unknown>;
    const fields: ProblemFields = {};
    const type = readString(source, "type");
    const title = readString(source, "title");
    const detail = readString(source, "detail");
    if (type !== undefined) fields.type = type;
    if (title !== undefined) fields.title = title;
    if (detail !== undefined) fields.detail = detail;
    return fields;
  }
  return {};
}

function clip(text: string): string {
  return text.length > MAX_DETAIL_LENGTH
    ? `${text.slice(0, MAX_DETAIL_LENGTH)}…`
    : text;
}

/**
 * Extract problem-details fields from a response body without consuming it.
 * CBOR bodies (`application/problem+cbor`, and `application/cbor`, which
 * canopy-api uses for most of its problem bodies) are decoded
 * deterministically; JSON bodies are parsed; a text body becomes the detail.
 * A body that does not decode yields no fields rather than an error: logging
 * must never turn a problem response into a failure.
 */
export async function problemFieldsFromResponse(
  response: Response,
): Promise<ProblemFields> {
  const contentType = (
    response.headers.get("content-type") ?? ""
  ).toLowerCase();
  try {
    if (contentType.includes("cbor")) {
      const bytes = new Uint8Array(await response.clone().arrayBuffer());
      if (bytes.length === 0) return {};
      return pickProblemFields(decodeCborDeterministic(bytes));
    }
    if (contentType.includes("json")) {
      const text = await response.clone().text();
      if (text.length === 0) return {};
      return pickProblemFields(JSON.parse(text));
    }
    if (contentType.startsWith("text/")) {
      const text = (await response.clone().text()).trim();
      return text.length > 0 ? { detail: text } : {};
    }
  } catch {
    return {};
  }
  return {};
}

/**
 * Write one log line for a problem response and return the response
 * unchanged. Responses below 400 pass through untouched (no body read).
 */
export async function logProblemResponse(
  request: Request,
  response: Response,
  opts: LogProblemResponseOptions = {},
): Promise<Response> {
  if (response.status < 400) return response;

  let path: string;
  try {
    path = new URL(request.url).pathname;
  } catch {
    path = request.url;
  }
  const fields = await problemFieldsFromResponse(response);
  const entry: ProblemLogEntry = {
    event: "problem_response",
    level: response.status >= 500 ? "error" : "warn",
    ...(opts.service !== undefined ? { service: opts.service } : {}),
    method: request.method,
    path,
    route: opts.route ?? routePattern(path),
    status: response.status,
    ...(fields.type !== undefined ? { type: fields.type } : {}),
    ...(fields.title !== undefined ? { title: fields.title } : {}),
    ...(fields.detail !== undefined ? { detail: clip(fields.detail) } : {}),
  };
  const ray = request.headers.get("cf-ray");
  if (ray) entry.ray = ray;

  const log = opts.log ?? console;
  log[entry.level](JSON.stringify(entry));
  return response;
}
