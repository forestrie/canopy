/**
 * Poll-once primitive for SCRAPI resolve-receipt: a single GET of the
 * permanent receipt URL. NO sleep loops here — callers own retry pacing.
 *
 * A 404 here means there is nothing at this receipt URL — it is not the
 * "still sequencing" ambiguity, which lives entirely in
 * query-registration-status's 303 contract (see {@link RegistrationPollStatus}
 * in `./query-registration.js`). {@link resolveReceiptRaw} is the underlying
 * network call — the raw exchange for EVERY status — and {@link
 * resolveReceiptOnce} is the parsed interpretation built on top of it
 * (plan-2609-07 decision L2).
 */

import { decodeProblemDetailsBytes } from "./problem-details.js";
import type { ProblemDetails } from "./problem-details.js";
import { toRawResponse } from "./raw-response.js";
import type { RawResponse } from "./raw-response.js";

export type ReceiptResolution =
  /** 404: nothing at this receipt URL. */
  | { status: "not_found"; problem?: ProblemDetails }
  /** 200 with the receipt body. */
  | {
      status: "receipt";
      httpStatus: number;
      headers: { [key: string]: string };
      body: Uint8Array;
    }
  /** Any other status: not retryable. */
  | { status: "error"; httpStatus: number; problem?: ProblemDetails };

export interface ResolveReceiptRawOptions {
  receiptUrl: string;
  /** Defaults to `application/cbor`. */
  accept?: string;
  fetchImpl?: typeof fetch;
}

export type ResolveReceiptOnceOptions = ResolveReceiptRawOptions;

/**
 * GET resolve-receipt once, returning the raw exchange for EVERY status — no
 * throwing, no interpretation. Uses `redirect: "manual"` for parity with
 * every other network function in this package.
 */
export async function resolveReceiptRaw(
  opts: ResolveReceiptRawOptions,
): Promise<RawResponse> {
  const doFetch = opts.fetchImpl ?? fetch;
  const res = await doFetch(opts.receiptUrl, {
    headers: { Accept: opts.accept ?? "application/cbor" },
    redirect: "manual",
  });
  return toRawResponse(opts.receiptUrl, res);
}

/** GET resolve-receipt once: 200 receipt, 404 not_found, anything else error. */
export async function resolveReceiptOnce(
  opts: ResolveReceiptOnceOptions,
): Promise<ReceiptResolution> {
  const raw = await resolveReceiptRaw(opts);

  if (raw.status === 200) {
    return {
      status: "receipt",
      httpStatus: raw.status,
      headers: raw.headers,
      body: raw.body,
    };
  }

  const problem = decodeProblemDetailsBytes(
    raw.body,
    raw.headers["content-type"],
  );
  if (raw.status === 404) {
    return { status: "not_found", problem };
  }
  return { status: "error", httpStatus: raw.status, problem };
}
