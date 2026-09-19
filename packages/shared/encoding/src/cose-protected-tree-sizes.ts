/**
 * Read `tree-size-1` / `tree-size-2` (ADR-0066 D3) from COSE protected
 * header map bytes, as produced by
 * {@link encodeCoseProtectedMapBytes}/{@link encodeCoseProtectedWithKid}.
 */

import {
  COSE_LABEL_TREE_SIZE_1,
  COSE_LABEL_TREE_SIZE_2,
} from "./cose-labels.js";
import { decodeCborDeterministic } from "./decode-cbor-deterministic.js";

function toUnsignedBigint(v: unknown, label: string): bigint {
  if (typeof v === "bigint") {
    if (v < 0n) {
      throw new Error(
        `readProtectedTreeSizes: ${label} is not an unsigned integer (bigint ${v})`,
      );
    }
    return v;
  }
  if (typeof v === "number") {
    if (!Number.isInteger(v) || v < 0) {
      throw new Error(
        `readProtectedTreeSizes: ${label} is not an unsigned integer (number ${v})`,
      );
    }
    return BigInt(v);
  }
  throw new Error(
    `readProtectedTreeSizes: ${label} is not an unsigned integer (got ${typeof v})`,
  );
}

/**
 * Decode `tree-size-1` (label {@link COSE_LABEL_TREE_SIZE_1}) and
 * `tree-size-2` (label {@link COSE_LABEL_TREE_SIZE_2}) out of a COSE
 * protected header map.
 *
 * `protectedMapBytes` is the protected header **map** bytes — the CONTENTS
 * of the COSE Sign1 `[0]` bstr, not the bstr wrapper itself. This is the
 * same shape `DecodedCoseSign1.protectedBstr` (see `verify-cose-sign1.ts`)
 * already hands callers: `decodeCborDeterministic`'s byte-string decoding
 * (major type 2) returns the raw content bytes, so `decodeCoseSign1` never
 * re-wraps them — `extractAlgFromProtected` takes the same shape for the
 * same reason.
 *
 * @param protectedMapBytes - Protected header map bytes (bstr contents)
 * @returns Both sizes as bigints when both labels are present as unsigned
 *   integers; `null` when neither label is present
 * @throws When exactly one of the two labels is present, when the decoded
 *   protected header is not a CBOR map, or when a present value is not an
 *   unsigned integer
 */
export function readProtectedTreeSizes(
  protectedMapBytes: Uint8Array,
): { treeSize1: bigint; treeSize2: bigint } | null {
  const decoded = decodeCborDeterministic(protectedMapBytes);
  if (!(decoded instanceof Map)) {
    throw new Error(
      "readProtectedTreeSizes: protected header is not a CBOR map",
    );
  }
  const raw1 = decoded.get(COSE_LABEL_TREE_SIZE_1);
  const raw2 = decoded.get(COSE_LABEL_TREE_SIZE_2);
  const has1 = raw1 !== undefined;
  const has2 = raw2 !== undefined;
  if (!has1 && !has2) return null;
  if (has1 !== has2) {
    throw new Error(
      "readProtectedTreeSizes: tree-size-1 and tree-size-2 must both be present or both be absent",
    );
  }
  return {
    treeSize1: toUnsignedBigint(raw1, "tree-size-1"),
    treeSize2: toUnsignedBigint(raw2, "tree-size-2"),
  };
}
