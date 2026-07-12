/** RFC 9457 problem details as returned by canopy-api SCRAPI routes (CBOR). */

import { decodeCborDeterministic } from "@forestrie/encoding";

export type ProblemDetails = {
  type?: string;
  title?: string;
  status?: number;
  detail?: string;
  instance?: string;
  [key: string]: unknown;
};

/** Decode a CBOR problem-details body; undefined when empty or not CBOR. */
export function decodeProblemDetailsBytes(
  body: Uint8Array | undefined,
): ProblemDetails | undefined {
  if (!body || body.length === 0) {
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
