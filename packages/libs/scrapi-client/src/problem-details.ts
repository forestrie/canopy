/** RFC 9457 problem details as returned by canopy-api SCRAPI routes (CBOR). */

import { decodeCborDeterministic } from "@forestrie/encoding";

/** Media type problem-details bodies are served under (any HTTP status). */
export const PROBLEM_DETAILS_CONTENT_TYPE = "application/problem+cbor";

export type ProblemDetails = {
  type?: string;
  title?: string;
  status?: number;
  detail?: string;
  instance?: string;
  [key: string]: unknown;
};

/**
 * Decode a CBOR problem-details body; undefined when empty or not CBOR.
 *
 * When `contentType` is given and is not {@link PROBLEM_DETAILS_CONTENT_TYPE},
 * decoding is skipped without attempting to parse the bytes — a receipt or
 * other CBOR body is not problem details just because it happens to decode
 * as a map (plan-2609-07 decision L2: decoding applies to
 * `application/problem+cbor` bodies on any status). When `contentType` is
 * omitted, the body is still tried opportunistically for call sites that do
 * not have the header at hand.
 */
export function decodeProblemDetailsBytes(
  body: Uint8Array | undefined,
  contentType?: string,
): ProblemDetails | undefined {
  if (!body || body.length === 0) {
    return undefined;
  }
  if (
    contentType !== undefined &&
    !contentType.toLowerCase().includes(PROBLEM_DETAILS_CONTENT_TYPE)
  ) {
    return undefined;
  }
  try {
    const decoded = decodeCborDeterministic(body);
    // The deterministic decoder returns CBOR maps as JS `Map`; problem details
    // are a string-keyed map, so flatten it to the plain-object shape callers
    // read (`problem.detail`, `problem.title`, …).
    if (!(decoded instanceof Map)) {
      return undefined;
    }
    return Object.fromEntries(decoded) as ProblemDetails;
  } catch {
    return undefined;
  }
}
