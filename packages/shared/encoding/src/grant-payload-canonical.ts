/**
 * Canonical (tag-free) CBOR emission for grant v0 payloads and COSE assembly.
 *
 * arbor (fxamacker) rebuilds the `Sig_structure` from the bare protected/payload
 * byte strings, so the signed bytes must be canonical. `cbor-x` would tag `Map`
 * (tag 259) and `Uint8Array` (tag 64), which diverges from arbor's canonical
 * encoding and breaks verification — so the grant payload, `Sig_structure`, and
 * Sign1 are emitted byte-by-byte here.
 */

import type { Grant } from "./grant.js";
import { toPaddedWire32 } from "./uuid-bytes.js";
import { grantDataToBytes } from "./grant-data.js";

const WIRE_GRANT_FLAGS_BYTES = 8;

export function appendCborUint(out: number[], v: number): void {
  if (v < 24) out.push(v);
  else if (v <= 0xff) out.push(0x18, v);
  else if (v <= 0xffff) out.push(0x19, (v >> 8) & 0xff, v & 0xff);
  else
    out.push(
      0x1a,
      (v >>> 24) & 0xff,
      (v >> 16) & 0xff,
      (v >> 8) & 0xff,
      v & 0xff,
    );
}

/** Append a CBOR byte string (major type 2) with canonical length prefix. */
export function appendCborBstr(out: number[], bytes: Uint8Array): void {
  const n = bytes.length;
  if (n < 24) out.push(0x40 | n);
  else if (n <= 0xff) out.push(0x58, n);
  else if (n <= 0xffff) out.push(0x59, (n >> 8) & 0xff, n & 0xff);
  else
    out.push(
      0x5a,
      (n >>> 24) & 0xff,
      (n >> 16) & 0xff,
      (n >> 8) & 0xff,
      n & 0xff,
    );
  for (let i = 0; i < n; i++) out.push(bytes[i]!);
}

/** Append a CBOR text string (major type 3). */
export function appendCborText(out: number[], s: string): void {
  const bytes = new TextEncoder().encode(s);
  const n = bytes.length;
  if (n < 24) out.push(0x60 | n);
  else if (n <= 0xff) out.push(0x78, n);
  else out.push(0x79, (n >> 8) & 0xff, n & 0xff);
  for (let i = 0; i < n; i++) out.push(bytes[i]!);
}

export function leftPadBytes(b: Uint8Array, length: number): Uint8Array {
  if (b.length === length) return b;
  if (b.length > length) return b.slice(-length);
  const out = new Uint8Array(length);
  out.set(b, length - b.length);
  return out;
}

/**
 * Canonical grant v0 payload CBOR (map keys 1-6, no idtimestamp), matching
 * `encodeGrantForResponse` minus key 0. Tag-free so arbor decodes `grantData`
 * as a bare 64-byte byte string.
 */
export function encodeGrantPayloadV0Canonical(grant: Grant): Uint8Array {
  const logId32 = toPaddedWire32(grant.logId as Uint8Array);
  const ownerLogId32 = toPaddedWire32(grant.ownerLogId as Uint8Array);
  const flags8 = leftPadBytes(
    grant.grant as Uint8Array,
    WIRE_GRANT_FLAGS_BYTES,
  );
  const grantData = grantDataToBytes(grant.grantData ?? new Uint8Array(0));

  const out: number[] = [0xa6]; // map(6) — keys 1-6
  out.push(0x01);
  appendCborBstr(out, logId32);
  out.push(0x02);
  appendCborBstr(out, ownerLogId32);
  out.push(0x03);
  appendCborBstr(out, flags8);
  out.push(0x04);
  appendCborUint(out, grant.maxHeight ?? 0);
  out.push(0x05);
  appendCborUint(out, grant.minGrowth ?? 0);
  out.push(0x06);
  appendCborBstr(out, grantData);
  return new Uint8Array(out);
}
