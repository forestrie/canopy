/**
 * The one canonical map-key order for `@forestrie/encoding`: **length-first,
 * then bytewise** on the encoded key bytes (RFC 7049 §3.9, the rule fxamacker
 * calls `SortCanonical` / `SortLengthFirst`).
 *
 * Every verifier that reads a Forestrie checkpoint protected header applies
 * this order:
 *
 * - ADR-0066 D9 states it ("keys in canonical order (shorter encoding first,
 *   then bytewise)");
 * - go-merklelog's `decodeProtectedHeader` re-encodes the header with
 *   `canonicalReceiptCBOR` = `cbor.CanonicalEncOptions()` (`Sort:
 *   SortCanonical`, `massifs/checkpointreceipt.go`) and requires the result to
 *   be byte-identical to the input, so a header whose keys are in any other
 *   order is rejected;
 * - the univocity parser's `compareEncodedKeys` (`src/cosecbor/cosecbor.sol`,
 *   on the unmerged branch of univocity PR #43, not on `main`) is the same
 *   comparator.
 *
 * RFC 8949 §4.2.1 "core deterministic" order is instead **pure bytewise**.
 * The two orders differ only when a map mixes a negative label whose encoding
 * is strictly shorter than a positive label's encoding in the same map — for
 * example `-1` (`20`, 1 byte) beside `395` (`19 018b`, 3 bytes): length-first
 * puts `-1` first, bytewise puts `395` first. Keys of equal length, and text
 * keys of any length, order identically under both rules, which is why no map
 * the estate emits today changes bytes.
 *
 * Both the encoder ({@link ./encode-cbor-deterministic.ts}) and the decoder's
 * key-order check ({@link ./decode-cbor-deterministic.ts}) call this function,
 * so `encode → decode` round-trips for every key class, not only the ones in
 * use.
 */

/**
 * Compare two encoded CBOR map keys in canonical order: the shorter encoding
 * sorts first, equal lengths compare bytewise.
 *
 * @param a - Encoded key bytes
 * @param b - Encoded key bytes
 * @returns Negative if `a` sorts before `b`, positive if after, 0 if the two
 *   encodings are identical (which is a duplicate key)
 */
export function compareCanonicalKeys(a: Uint8Array, b: Uint8Array): number {
  if (a.length !== b.length) return a.length - b.length;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return a[i]! - b[i]!;
  }
  return 0;
}
