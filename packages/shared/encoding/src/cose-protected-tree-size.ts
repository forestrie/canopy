/**
 * Read the signed `tree-size-2` from a checkpoint's protected header
 * (ADR-0066 D1 as amended 2026-09-20: only tree-size-2 is signed).
 *
 * The input is the protected header MAP bytes, i.e. the contents of the
 * COSE Sign1 element-0 byte string, not the byte string itself. The header
 * is decoded with {@link decodeCborDeterministicStrict}, which applies
 * ADR-0066 D9 "Protected-header conformance": shortest-form arguments,
 * definite lengths only, keys in canonical order (shorter encoding first,
 * then bytewise) with no duplicates, no tags, integer keys within int64, a
 * string length within the remaining bytes, and the map consuming the whole
 * header. A label this reader does not read is skipped when its value is any
 * well-formed definite-length item, major type 7 included. So two conformant
 * verifiers either read the same size from a header or both reject it.
 */
import { COSE_LABEL_TREE_SIZE_2 } from "./cose-labels.js";
import {
  CborFloat,
  CborSimple,
  CborTag,
  decodeCborDeterministicStrict,
} from "./decode-cbor-deterministic.js";

/**
 * Decode `tree-size-2` (label {@link COSE_LABEL_TREE_SIZE_2}) from protected
 * header map bytes.
 *
 * @returns the signed size as a bigint, or `null` when the label is absent
 * @throws when the header is not a CBOR map, is not deterministically
 *   encoded (ADR-0066 D9), or the label's value is not a CBOR unsigned
 *   integer (major type 0): a negative integer, byte string, float, simple
 *   value or tagged value under the label is rejected, never reinterpreted
 */
export function readProtectedTreeSize2(
  protectedMapBytes: Uint8Array,
): bigint | null {
  // Tags are rejected anywhere in a protected header, so a bignum under the
  // label cannot stand in for the unsigned integer the profile requires.
  const decoded = decodeCborDeterministicStrict(protectedMapBytes);
  if (!(decoded instanceof Map)) {
    throw new Error(
      "readProtectedTreeSize2: protected header is not a CBOR map",
    );
  }
  if (!decoded.has(COSE_LABEL_TREE_SIZE_2)) return null;
  const raw = decoded.get(COSE_LABEL_TREE_SIZE_2);
  if (typeof raw === "bigint") {
    if (raw < 0n) {
      throw new Error(
        `readProtectedTreeSize2: tree-size-2 is not an unsigned integer (bigint ${raw})`,
      );
    }
    return raw;
  }
  if (typeof raw === "number" && Number.isInteger(raw) && raw >= 0) {
    return BigInt(raw);
  }
  throw new Error(
    `readProtectedTreeSize2: tree-size-2 is not an unsigned integer (got ${describeValue(
      raw,
    )})`,
  );
}

/** Name the CBOR shape found under the label, for the rejection message. */
function describeValue(raw: unknown): string {
  if (raw === null) return "null";
  if (raw instanceof CborFloat) return `float ${raw.value}`;
  if (raw instanceof CborSimple) return `simple value ${raw.value}`;
  if (raw instanceof CborTag) return `tag ${raw.tag}`;
  if (raw instanceof Uint8Array) return "byte string";
  if (raw instanceof Map) return "map";
  if (Array.isArray(raw)) return "array";
  return typeof raw;
}
