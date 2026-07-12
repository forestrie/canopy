/**
 * Shared byte coercion and comparison helpers for COSE parsing and Web Crypto
 * interop. Normalizes CBOR decode outputs and ArrayBuffer views into
 * `Uint8Array` for consistent length checks across the package.
 */

/**
 * Coerce decoded CBOR or buffer-like values to `Uint8Array`.
 *
 * @param value - Decoded CBOR field or buffer view.
 * @param label - Field name included in error messages.
 * @throws When `value` is not bytes.
 */
export function bytesFromUnknown(value: unknown, label: string): Uint8Array {
  if (value instanceof Uint8Array) return value;
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  throw new Error(`${label} is not bytes`);
}

/**
 * Copy a `Uint8Array` into a standalone `ArrayBuffer` for Web Crypto APIs.
 *
 * @param bytes - View that may share a larger underlying buffer.
 */
export function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
}

/**
 * Constant-time length-safe byte equality for recovered addresses and digests.
 *
 * @param a - First byte sequence.
 * @param b - Second byte sequence.
 */
export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}
