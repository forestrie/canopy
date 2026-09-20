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
 * header.
 *
 * A label this reader does not read is skipped, but only when its value is
 * one of the types D9 as narrowed by forestrie/protocol#10 allows an unread
 * label to carry: an integer, a byte string, a valid-UTF-8 text string,
 * `false`/`true`/`null`, or a shortest-form float. This is narrower than the
 * generic decoder's own "any well-formed definite-length item" (major type 7
 * included) — a container (array or map) or any other CBOR simple value
 * (e.g. `simple(40)`) under an unread label is rejected here even though the
 * generic decoder would happily decode it, because go-merklelog and the
 * univocity parser both reject it too and cross-verifier agreement is the
 * entire point of a protected header profile: a header one verifier skips
 * over and another cannot even parse is not one every verifier answers the
 * same size for. CBOR `undefined` and a non-shortest-form float are already
 * rejected by the decoder itself. Tags are rejected anywhere in the header
 * (decoded with `{ tags: "reject" }`).
 *
 * This reader additionally requires every LABEL in the header to be an
 * integer. ADR-0066 D9 bounds integer key magnitude but never says keys must
 * be integers, so the generic decoder still accepts a text- or
 * container-keyed map (plain-object encoding produces text-keyed maps that
 * other callers rely on). A protected header is not such a map: go-merklelog
 * unmarshals one into `map[int64]any` and the univocity parser reads every
 * label with `readInteger`, so both reject a non-integer label and this
 * reader would otherwise be the one verifier reading a size from a header the
 * chain will not anchor (review H4).
 */
import { COSE_LABEL_TREE_SIZE_2 } from "./cose-labels.js";
import {
  CborFloat,
  CborSimple,
  CborTag,
  decodeCborDeterministicStrict,
} from "./decode-cbor-deterministic.js";

/**
 * Whether `value` is one of the types D9 as narrowed by protocol#10 allows a
 * protected-header entry to carry: integer, byte string, text string,
 * `false`/`true`/`null`, or a (already shortest-form-checked) float. Every
 * other well-formed CBOR value the generic decoder can produce here — an
 * array, a map, or a {@link CborSimple} (any major-type-7 simple value other
 * than false/true/null) — is excluded. `CborTag` is listed only for
 * completeness; the decoder rejects tags before this runs.
 */
function isAllowedHeaderValue(value: unknown): boolean {
  if (typeof value === "number" || typeof value === "bigint") return true;
  if (typeof value === "string") return true;
  if (typeof value === "boolean" || value === null) return true;
  if (value instanceof Uint8Array) return true;
  if (value instanceof CborFloat) return true;
  return false;
}

/**
 * Decode `tree-size-2` (label {@link COSE_LABEL_TREE_SIZE_2}) from protected
 * header map bytes.
 *
 * @returns the signed size as a bigint, or `null` when the label is absent
 * @throws when the header is not a CBOR map, is not deterministically
 *   encoded (ADR-0066 D9), carries a label that is not an integer, carries a
 *   value of a type D9 as narrowed excludes (a container, or a simple value
 *   other than false/true/null — see {@link isAllowedHeaderValue}), or the
 *   `tree-size-2` label's value is not a CBOR unsigned integer (major type
 *   0): a negative integer, byte string, float, simple value or tagged value
 *   under the label is rejected, never reinterpreted
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
  for (const [label, value] of decoded) {
    if (typeof label !== "number" && typeof label !== "bigint") {
      throw new Error(
        `readProtectedTreeSize2: protected header label is not an integer (got ${describeValue(
          label,
        )})`,
      );
    }
    if (!isAllowedHeaderValue(value)) {
      throw new Error(
        `readProtectedTreeSize2: protected header label ${label} carries an excluded value type (got ${describeValue(
          value,
        )})`,
      );
    }
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
  if (typeof raw === "string") return `text string ${JSON.stringify(raw)}`;
  if (raw instanceof Uint8Array) return "byte string";
  if (raw instanceof Map) return "map";
  if (Array.isArray(raw)) return "array";
  return typeof raw;
}
