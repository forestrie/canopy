/**
 * Poll-once primitive for SCRAPI query-registration-status: a single GET of
 * the status URL, interpreted as a discriminated status. NO sleep loops here —
 * callers (e.g. the e2e kit's arithmetic backoff ladder) own retry pacing.
 *
 * {@link queryRegistrationRaw} is the underlying network call — the raw
 * exchange for EVERY status, `redirect: "manual"` so the 303 contract's
 * Location survives — and {@link queryRegistrationOnce} is the SCRAPI
 * 303-contract interpretation built on top of it (plan-2609-07 decision L2).
 */

import { decodeProblemDetailsBytes } from "./problem-details.js";
import type { ProblemDetails } from "./problem-details.js";
import { toRawResponse } from "./raw-response.js";
import type { RawResponse } from "./raw-response.js";
import { toAbsoluteScrapiUrl } from "./scrapi-url.js";

/** Location points at GET resolve-receipt (permanent URL with massif height). */
export const RECEIPT_LOCATION_RE =
  /\/logs\/[^/]+\/[^/]+\/\d+\/entries\/[0-9a-f]{32}\/receipt(?:\?|$)/i;

/** Permanent entryId (32 hex chars) from a receipt redirect Location. */
export function parseEntryIdFromReceiptLocation(location: string): string {
  const m = location.match(/\/entries\/([0-9a-f]{32})\/receipt/i);
  if (!m) {
    throw new Error(
      `Could not parse entryId from receipt Location: ${location}`,
    );
  }
  return m[1]!.toLowerCase();
}

export type RegistrationPollStatus =
  /** 303 back to a non-receipt Location: sequencing still pending. */
  | { status: "pending"; location: string; retryAfterMs?: number }
  /** 303 to the permanent receipt URL. */
  | { status: "receipt"; receiptUrl: string; entryIdHex: string }
  /** Anything that is not the 303 contract (including 303 without Location). */
  | {
      status: "error";
      httpStatus: number;
      problem?: ProblemDetails;
      detail: string;
    };

export interface QueryRegistrationRawOptions {
  /** GET /logs/{bootstrap}/{logId}/entries/{innerHex} (registration status). */
  statusUrl: string;
  /** Defaults to `application/cbor`. */
  accept?: string;
  fetchImpl?: typeof fetch;
}

export interface QueryRegistrationOnceOptions
  extends QueryRegistrationRawOptions {
  /** Used to absolutize a relative receipt Location. */
  baseUrl: string;
}

/**
 * GET query-registration-status once, returning the raw exchange for EVERY
 * status — no throwing, no interpretation. Uses `redirect: "manual"` so a
 * 303 comes back as a 303 with its `location` header rather than being
 * followed.
 */
export async function queryRegistrationRaw(
  opts: QueryRegistrationRawOptions,
): Promise<RawResponse> {
  const doFetch = opts.fetchImpl ?? fetch;
  const res = await doFetch(opts.statusUrl, {
    headers: { Accept: opts.accept ?? "application/cbor" },
    redirect: "manual",
  });
  return toRawResponse(opts.statusUrl, res);
}

/**
 * GET query-registration-status once. The worker answers 303 either back to a
 * pending status Location (optionally with Retry-After) or to the permanent
 * receipt URL (`/logs/.../{massifHeight}/entries/{entryId}/receipt`).
 */
export async function queryRegistrationOnce(
  opts: QueryRegistrationOnceOptions,
): Promise<RegistrationPollStatus> {
  const raw = await queryRegistrationRaw(opts);

  if (raw.status !== 303) {
    const problem = decodeProblemDetailsBytes(
      raw.body,
      raw.headers["content-type"],
    );
    return {
      status: "error",
      httpStatus: raw.status,
      problem,
      detail: problem?.detail ?? `expected 303, got ${raw.status}`,
    };
  }

  const location = raw.headers["location"];
  if (!location) {
    return {
      status: "error",
      httpStatus: 303,
      detail: "303 without Location",
    };
  }

  if (RECEIPT_LOCATION_RE.test(location)) {
    return {
      status: "receipt",
      receiptUrl: toAbsoluteScrapiUrl(opts.baseUrl, location),
      entryIdHex: parseEntryIdFromReceiptLocation(location),
    };
  }

  const retryAfterSec = Number.parseInt(raw.headers["retry-after"] ?? "0", 10);
  return {
    status: "pending",
    location,
    retryAfterMs:
      Number.isFinite(retryAfterSec) && retryAfterSec > 0
        ? retryAfterSec * 1000
        : undefined,
  };
}
