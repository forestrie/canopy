/**
 * Strict uint64 reader for integer-keyed CBOR payload labels, such as the
 * delegation MMR range (labels 3/4). Absent is an error here; callers that
 * give an absent label a legacy meaning (receipt-verify's
 * `resolve-delegated-verify-key.ts`, where labels 3 and 4 both absent mean
 * a legacy certificate with no window)
 * test presence first and use {@link toUint64} on the value.
 */

import { toUint64 } from "./to-uint64.js";

/**
 * Read `label` from a decoded payload map as a uint64.
 *
 * @param payloadMap - Decoded integer-keyed payload map.
 * @param label - Payload label to read.
 * @param name - Field name for error messages (e.g. `mmrEnd`).
 * @returns The value as `bigint` in `[0, 2^64-1]`.
 * @throws When the label is missing, or present but not a uint64 (see
 *   {@link toUint64}).
 */
export function readUint64Label(
  payloadMap: ReadonlyMap<number, unknown>,
  label: number,
  name: string,
): bigint {
  if (!payloadMap.has(label)) {
    throw new Error(`payload missing ${name} (label ${label})`);
  }
  return toUint64(payloadMap.get(label), `${name} (label ${label})`);
}
