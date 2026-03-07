/**
 * Coerce unknown values to primitive types when decoding CBOR or other untrusted input.
 * Use for grant/codec, register-grant, and any CBOR map field parsing.
 */

export function toBytes(v: unknown): Uint8Array | undefined {
  if (v instanceof Uint8Array) return v;
  if (v instanceof ArrayBuffer) return new Uint8Array(v);
  if (Array.isArray(v) && v.every((x) => typeof x === "number")) {
    return new Uint8Array(v as number[]);
  }
  return undefined;
}

export function toString(v: unknown): string | undefined {
  if (typeof v === "string") return v;
  return undefined;
}

export function toNumber(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isInteger(v)) return v;
  return undefined;
}

/**
 * Like toBytes but returns undefined if the byte length is not exactly the given length.
 */
export function toBytesLength(v: unknown, length: number): Uint8Array | undefined {
  const b = toBytes(v);
  return b && b.length === length ? b : undefined;
}
