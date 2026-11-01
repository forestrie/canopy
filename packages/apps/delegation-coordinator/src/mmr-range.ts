/**
 * Inclusive delegation MMR range, parsed from a coordinator JSON body.
 *
 * The range is payload labels 3/4 of the delegation certificate
 * (`@forestrie/delegation-cose`), a uint64 everywhere it is built, stored and
 * checked (plan-2611-01, FOR-613). On the wire each bound is a canonical
 * decimal string ({@link parseDecimalUint64}); after parsing it is `bigint`.
 */

import { DecimalUint64Error, parseDecimalUint64 } from "./decimal-uint64.js";

/** An inclusive MMR index range with `mmrStart <= mmrEnd`. */
export interface MmrRange {
  mmrStart: bigint;
  mmrEnd: bigint;
}

/**
 * Parse `mmrStart` / `mmrEnd` from a JSON request body.
 *
 * @param body - The decoded JSON body; both fields must be canonical decimal
 *   uint64 strings.
 * @returns The range as `bigint`.
 * @throws {@link DecimalUint64Error} when a bound is missing or malformed, or
 *   `mmrStart > mmrEnd`. Callers answer 400.
 */
export function parseJsonMmrRange(body: {
  mmrStart?: unknown;
  mmrEnd?: unknown;
}): MmrRange {
  const mmrStart = parseDecimalUint64(body.mmrStart, "mmrStart");
  const mmrEnd = parseDecimalUint64(body.mmrEnd, "mmrEnd");
  if (mmrStart > mmrEnd) {
    throw new DecimalUint64Error("mmrStart must not exceed mmrEnd");
  }
  return { mmrStart, mmrEnd };
}
