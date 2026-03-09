/**
 * Concise Problem Details (RFC 9290) — types and shared encoder.
 * Call sites may keep separate implementations that re-use this interface and encoder.
 */

import { encode } from "cbor-x";

/** Generic problem detail shape (string keys for application/cbor). */
export interface ProblemDetail {
  type?: string;
  title: string;
  status: number;
  detail?: string;
  instance?: string;
  reason?: string;
  [key: string]: unknown;
}

/**
 * Encode problem detail to CBOR (application/problem+cbor).
 * Single implementation for consistent encoding; call sites can use this or re-use the interface.
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
  const encoded = encode(body);
  return encoded instanceof Uint8Array ? encoded : new Uint8Array(encoded);
}
