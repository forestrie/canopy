/**
 * Concise Problem Details (RFC 9290) — types and shared encoder.
 * Canopy SCRAPI error responses use `application/problem+cbor`; call sites may
 * wrap this encoder or reuse {@link ProblemDetail} for consistent fields.
 */

import { encodeCborDeterministic } from "./encode-cbor-deterministic.js";

/** Generic problem detail shape (string keys for application/problem+cbor). */
export interface ProblemDetail {
  /** Problem type URI; defaults to `about:blank` when omitted at encode time. */
  type?: string;
  /** Short human-readable summary. */
  title: string;
  /** HTTP status code echoed in the problem body. */
  status: number;
  /** Optional longer explanation. */
  detail?: string;
  /** URI identifying this occurrence. */
  instance?: string;
  /** Forestrie-specific machine reason (when present). */
  reason?: string;
  [key: string]: unknown;
}

/**
 * Encode problem detail to CBOR (`application/problem+cbor`).
 *
 * @param problem - Problem fields; unknown keys are copied through
 * @returns CBOR map bytes
 */
export function encodeProblemDetailsCbor(problem: ProblemDetail): Uint8Array {
  const body: Record<string, unknown> = {
    type: problem.type ?? "about:blank",
    title: problem.title,
    status: problem.status,
  };
  if (problem.detail !== undefined) body.detail = problem.detail;
  if (problem.instance !== undefined) body.instance = problem.instance;
  if (problem.reason !== undefined) body.reason = problem.reason;
  for (const [k, v] of Object.entries(problem)) {
    if (["type", "title", "status", "detail", "instance", "reason"].includes(k))
      continue;
    body[k] = v;
  }
  return encodeCborDeterministic(body);
}
