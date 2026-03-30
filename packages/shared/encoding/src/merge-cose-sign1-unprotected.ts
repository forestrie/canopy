/**
 * Merge key/value pairs into COSE Sign1 unprotected headers and re-encode.
 * Protected header, payload, and signature are unchanged (unprotected is not signed).
 */

import { decodeCoseSign1 } from "./verify-cose-sign1.js";
import { coseUnprotectedToMap } from "./cose-unprotected-map.js";
import { encodeCoseSign1Raw } from "./encode-cose-sign1-raw.js";

export function mergeUnprotectedIntoCoseSign1(
  coseSign1Bytes: Uint8Array,
  additions: ReadonlyMap<number, unknown>,
): Uint8Array {
  const decoded = decodeCoseSign1(coseSign1Bytes);
  if (!decoded) {
    throw new Error("mergeUnprotectedIntoCoseSign1: invalid COSE Sign1");
  }
  const merged = coseUnprotectedToMap(decoded.unprotected);
  for (const [k, v] of additions) {
    merged.set(k, v);
  }
  return encodeCoseSign1Raw(
    decoded.protectedBstr,
    merged,
    decoded.payloadBstr,
    decoded.signature,
  );
}
