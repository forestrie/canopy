/**
 * SCRAPI registration: POST a grant or signed statement to
 * `/register/{bootstrapLogId}/…` with `Authorization: Forestrie-Grant` and
 * interpret the 303 receipt-redirect contract (grants.md §11, ARC-0024).
 *
 * Fetch-injectable and browser-safe: callers may supply `fetchImpl` (e.g. a
 * Playwright-backed shim); redirects are never followed.
 */

import { encode as encodeCbor } from "cbor-x";
import {
  decodeProblemDetailsBytes,
  type ProblemDetails,
} from "./problem-details.js";
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
    const problem = decodeProblemDetailsBytes(view.body);
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
 * POST /register/{bootstrapLogId}/grants with the Forestrie-Grant header;
 * resolves with the registration status URL from the 303 Location.
 */
export async function registerGrant(
  opts: RegisterGrantOptions,
): Promise<RegisterRedirect> {
  const doFetch = opts.fetchImpl ?? fetch;
  const headers: Record<string, string> = {
    Authorization: forestrieGrantAuthorization(opts.grantBase64),
  };
  let body: Uint8Array | undefined;
  if (opts.parentGrantBase64) {
    headers["Content-Type"] = "application/cbor";
    body = new Uint8Array(
      encodeCbor({ parentGrant: base64ToBytes(opts.parentGrantBase64) }),
    );
  }
  const res = await doFetch(
    `${opts.baseUrl.replace(/\/$/, "")}/register/${opts.bootstrapLogId}/grants`,
    {
      method: "POST",
      headers,
      // Uint8Array<ArrayBufferLike> is not assignable to BodyInit under
      // TS >= 5.7 typed-array generics; runtime fetch accepts it.
      body: body as BodyInit | undefined,
      redirect: "manual",
    },
  );
  return interpretRegisterRedirect(await toResponseView(res), opts.baseUrl);
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
 * body and the Forestrie-Grant header; resolves with the registration status
 * URL from the 303 Location.
 */
export async function registerSignedStatement(
  opts: RegisterSignedStatementOptions,
): Promise<RegisterRedirect> {
  const doFetch = opts.fetchImpl ?? fetch;
  const res = await doFetch(
    `${opts.baseUrl.replace(/\/$/, "")}/register/${opts.bootstrapLogId}/entries`,
    {
      method: "POST",
      headers: {
        Authorization: forestrieGrantAuthorization(opts.grantBase64),
        "Content-Type": opts.contentType ?? COSE_SIGN1_CONTENT_TYPE,
      },
      body: opts.statement as unknown as BodyInit,
      redirect: "manual",
    },
  );
  return interpretRegisterRedirect(await toResponseView(res), opts.baseUrl);
}

async function toResponseView(res: Response): Promise<RegisterResponseView> {
  return {
    status: res.status,
    location: res.headers.get("location") ?? undefined,
    body: new Uint8Array(await res.arrayBuffer()),
  };
}

function base64ToBytes(b64: string): Uint8Array {
  const normalized = b64.replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(normalized);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}
