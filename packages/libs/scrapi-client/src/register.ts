/**
 * SCRAPI registration: POST a grant or signed statement to
 * `/register/{bootstrapLogId}/…` with `Authorization: Forestrie-Grant` and
 * interpret the 303 receipt-redirect contract (grants.md §11, ARC-0024).
 *
 * Fetch-injectable and browser-safe: callers may supply `fetchImpl` (e.g. a
 * Playwright-backed shim); redirects are never followed. {@link
 * registerGrantRaw} / {@link registerSignedStatementRaw} are the underlying
 * network calls — the raw exchange for EVERY status — with {@link
 * registerGrant} / {@link registerSignedStatement} as the 303-contract
 * interpretation built on top (plan-2609-07 decision L2).
 */

import { encodeCborDeterministic } from "@forestrie/encoding";
import {
  decodeProblemDetailsBytes,
  type ProblemDetails,
} from "./problem-details.js";
import { toRawResponse } from "./raw-response.js";
import type { RawResponse } from "./raw-response.js";
import { toAbsoluteScrapiUrl } from "./scrapi-url.js";

export const COSE_SIGN1_CONTENT_TYPE =
  'application/cose; cose-type="cose-sign1"';

/** `Authorization` header value carrying the base64 grant transparent statement. */
export function forestrieGrantAuthorization(grantBase64: string): string {
  return `Forestrie-Grant ${grantBase64}`;
}

/** Thrown when a register POST does not produce the expected 303 redirect. */
export class ScrapiRegistrationError extends Error {
  /** Response status; 303 means the redirect was malformed (no Location). */
  readonly httpStatus: number;
  readonly problem?: ProblemDetails;
  /** `problem.detail`, else a 200-char body preview, else `(empty body)`. */
  readonly detail: string;

  constructor(
    message: string,
    httpStatus: number,
    detail: string,
    problem?: ProblemDetails,
  ) {
    super(message);
    this.name = "ScrapiRegistrationError";
    this.httpStatus = httpStatus;
    this.detail = detail;
    this.problem = problem;
  }
}

/** Minimal response view so non-fetch HTTP stacks can share the interpretation. */
export interface RegisterResponseView {
  status: number;
  /** `Location` response header, if any. */
  location?: string;
  /** Raw response body (problem details on failure). */
  body?: Uint8Array;
  /** `Content-Type` response header, if known — gates problem-details decoding. */
  contentType?: string;
}

export interface RegisterRedirect {
  /** Absolute query-registration-status URL from the 303 Location. */
  statusUrl: string;
}

/**
 * Interpret a register POST response: 303 + Location is the only success
 * shape; anything else raises {@link ScrapiRegistrationError} carrying the
 * decoded problem details when present.
 */
export function interpretRegisterRedirect(
  view: RegisterResponseView,
  baseUrl: string,
): RegisterRedirect {
  if (view.status !== 303) {
    const problem = decodeProblemDetailsBytes(view.body, view.contentType);
    const bodyText = view.body?.length
      ? new TextDecoder().decode(view.body)
      : "";
    const detail =
      problem?.detail ?? (bodyText.slice(0, 200) || "(empty body)");
    throw new ScrapiRegistrationError(
      `register: expected 303, got ${view.status} (${detail})`,
      view.status,
      detail,
      problem,
    );
  }
  if (!view.location) {
    throw new ScrapiRegistrationError(
      "register: 303 without Location",
      view.status,
      "(missing Location)",
    );
  }
  return { statusUrl: toAbsoluteScrapiUrl(baseUrl, view.location) };
}

export interface RegisterGrantOptions {
  baseUrl: string;
  /** First path segment after `/register/` — forest bootstrap log id (UUID). */
  bootstrapLogId: string;
  /** Grant transparent statement, Forestrie-Grant header base64. */
  grantBase64: string;
  /**
   * For a child-**data** grant under an intermediate authority log A: A's
   * completed creation grant (base64). Sent in the CBOR request body as
   * `{ parentGrant: <bytes> }` (grants.md §11) so the worker verifies A's
   * seal from the receipt — no SequencingQueue dependence.
   */
  parentGrantBase64?: string;
  fetchImpl?: typeof fetch;
}

/**
 * POST /register/{bootstrapLogId}/grants with the Forestrie-Grant header,
 * returning the raw exchange for EVERY status — no throwing, no
 * interpretation. Uses `redirect: "manual"` so a 303 is never followed.
 */
export async function registerGrantRaw(
  opts: RegisterGrantOptions,
): Promise<RawResponse> {
  const doFetch = opts.fetchImpl ?? fetch;
  const headers: Record<string, string> = {
    Authorization: forestrieGrantAuthorization(opts.grantBase64),
  };
  let body: Uint8Array | undefined;
  if (opts.parentGrantBase64) {
    headers["Content-Type"] = "application/cbor";
    body = encodeCborDeterministic({
      parentGrant: base64ToBytes(opts.parentGrantBase64),
    });
  }
  const url = `${opts.baseUrl.replace(/\/$/, "")}/register/${opts.bootstrapLogId}/grants`;
  const res = await doFetch(url, {
    method: "POST",
    headers,
    // Uint8Array<ArrayBufferLike> is not assignable to BodyInit under
    // TS >= 5.7 typed-array generics; runtime fetch accepts it.
    body: body as BodyInit | undefined,
    redirect: "manual",
  });
  return toRawResponse(url, res);
}

/**
 * POST /register/{bootstrapLogId}/grants with the Forestrie-Grant header;
 * resolves with the registration status URL from the 303 Location.
 */
export async function registerGrant(
  opts: RegisterGrantOptions,
): Promise<RegisterRedirect> {
  const raw = await registerGrantRaw(opts);
  return interpretRegisterRedirect(rawToView(raw), opts.baseUrl);
}

export interface RegisterSignedStatementOptions {
  baseUrl: string;
  /** First path segment after `/register/` — forest bootstrap log id (UUID). */
  bootstrapLogId: string;
  /** Completed (receipt-bearing) grant, Forestrie-Grant header base64. */
  grantBase64: string;
  /** COSE Sign1 signed statement wire bytes. */
  statement: Uint8Array;
  /** Defaults to {@link COSE_SIGN1_CONTENT_TYPE}. */
  contentType?: string;
  fetchImpl?: typeof fetch;
}

/**
 * POST /register/{bootstrapLogId}/entries with a COSE Sign1 signed statement
 * body and the Forestrie-Grant header, returning the raw exchange for EVERY
 * status — no throwing, no interpretation. Uses `redirect: "manual"` so a
 * 303 is never followed.
 */
export async function registerSignedStatementRaw(
  opts: RegisterSignedStatementOptions,
): Promise<RawResponse> {
  const doFetch = opts.fetchImpl ?? fetch;
  const url = `${opts.baseUrl.replace(/\/$/, "")}/register/${opts.bootstrapLogId}/entries`;
  const res = await doFetch(url, {
    method: "POST",
    headers: {
      Authorization: forestrieGrantAuthorization(opts.grantBase64),
      "Content-Type": opts.contentType ?? COSE_SIGN1_CONTENT_TYPE,
    },
    body: opts.statement as unknown as BodyInit,
    redirect: "manual",
  });
  return toRawResponse(url, res);
}

/**
 * POST /register/{bootstrapLogId}/entries with a COSE Sign1 signed statement
 * body and the Forestrie-Grant header; resolves with the registration status
 * URL from the 303 Location.
 */
export async function registerSignedStatement(
  opts: RegisterSignedStatementOptions,
): Promise<RegisterRedirect> {
  const raw = await registerSignedStatementRaw(opts);
  return interpretRegisterRedirect(rawToView(raw), opts.baseUrl);
}

/**
 * Adapt a {@link RawResponse} to the {@link RegisterResponseView} shape
 * `interpretRegisterRedirect` expects.
 */
function rawToView(raw: RawResponse): RegisterResponseView {
  return {
    status: raw.status,
    location: raw.headers["location"],
    body: raw.body,
    contentType: raw.headers["content-type"],
  };
}

function base64ToBytes(b64: string): Uint8Array {
  const normalized = b64.replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(normalized);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}
