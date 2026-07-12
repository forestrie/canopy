/**
 * Test-only CBOR decode that recursively converts CBOR maps to plain objects,
 * mirroring cbor-x's legacy `mapsAsObjects: true` default.
 *
 * The canonical codec (`@forestrie/encoding`) ALWAYS decodes CBOR maps to a JS
 * `Map` (RFC 8949 §4.2, unlike cbor-x). Production code reads these via `.get()`.
 * These tests, however, assert on string-keyed response bodies (RFC 7807 problem
 * details, onboard/registration bodies) using object property access and
 * `toMatchObject`. This helper restores the object shape those assertions expect
 * so the migration off cbor-x is behaviour-preserving for the test's intent
 * without changing production decode semantics.
 */

import { decodeCborDeterministic } from "@forestrie/encoding";

function mapsToObjects(value: unknown): unknown {
  if (value instanceof Uint8Array) return value;
  if (Array.isArray(value)) return value.map(mapsToObjects);
  if (value instanceof Map) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of value.entries()) out[String(k)] = mapsToObjects(v);
    return out;
  }
  return value;
}

/** Decode CBOR and deep-convert maps to plain objects (test assertions only). */
export function decodeCborAsObject(bytes: Uint8Array): unknown {
  return mapsToObjects(decodeCborDeterministic(bytes));
}
