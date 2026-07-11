/** RFC 9457 problem details as returned by canopy-api SCRAPI routes (CBOR). */

import { decode as decodeCbor } from "cbor-x";

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
    return decodeCbor(body) as ProblemDetails;
  } catch {
    return undefined;
  }
}
