/**
 * CBOR helpers for Custodian `application/cbor` and `application/problem+cbor` bodies.
 */

import { decode as decodeCbor } from "cbor-x";

export function custodianDecodeCbor(buf: Uint8Array): unknown {
  return decodeCbor(buf);
}

export function custodianReadCborStringField(
  raw: unknown,
  field: string,
): string {
  if (raw instanceof Map) {
    for (const [k, v] of raw.entries()) {
      const ks = typeof k === "string" ? k : String(k);
      if (ks === field && typeof v === "string") return v;
    }
    return "";
  }
  if (raw && typeof raw === "object" && !(raw instanceof Uint8Array)) {
    const v = (raw as Record<string, unknown>)[field];
    return typeof v === "string" ? v : "";
  }
  return "";
}

export function custodianReadCborIntField(
  raw: unknown,
  field: string,
): number | undefined {
  if (raw instanceof Map) {
    for (const [k, v] of raw.entries()) {
      const ks = typeof k === "string" ? k : String(k);
      if (ks === field && typeof v === "number" && Number.isFinite(v)) return v;
    }
    return undefined;
  }
  if (raw && typeof raw === "object" && !(raw instanceof Uint8Array)) {
    const v = (raw as Record<string, unknown>)[field];
    return typeof v === "number" && Number.isFinite(v) ? v : undefined;
  }
  return undefined;
}

/** Short preview for assertion messages (problem+cbor or text). */
export function custodianBodyPreview(buf: Uint8Array, max = 220): string {
  if (buf.length <= max)
    return new TextDecoder("utf-8", { fatal: false }).decode(buf);
  return `${new TextDecoder("utf-8", { fatal: false }).decode(buf.subarray(0, max))}…`;
}
