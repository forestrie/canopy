/**
 * Canonical CBOR helpers for coordinator HTTP bodies.
 *
 * Wraps `@forestrie/encoding` (deterministic RFC 8949 §4.2 codec — the only
 * sanctioned CBOR path; non-canonical encoders are banned on the wire). The
 * deterministic decoder returns CBOR maps as JS `Map`; string-keyed request
 * and response structs are flattened to plain objects via
 * {@link decodeCborStruct} so typed field access keeps working.
 */

import {
  decodeCborDeterministic,
  encodeCborDeterministic,
} from "@forestrie/encoding";

/** Encode a value as canonical CBOR bytes. */
export function encodeCbor(value: unknown): Uint8Array {
  return encodeCborDeterministic(value);
}

/**
 * Decode a string-keyed CBOR map body into a plain object of type `T`.
 *
 * @param bytes - Canonical CBOR of a flat, string-keyed struct.
 * @returns Plain object; values (bstr, ints) are left as decoded.
 */
export function decodeCborStruct<T>(bytes: Uint8Array): T {
  const decoded = decodeCborDeterministic(bytes);
  if (decoded instanceof Map) {
    return Object.fromEntries(decoded) as T;
  }
  return decoded as T;
}
