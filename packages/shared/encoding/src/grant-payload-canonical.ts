/**
 * Canonical (tag-free) CBOR emission helpers for COSE assembly, and the grant
 * v0 payload under its canonical name.
 *
 * arbor (fxamacker) rebuilds the `Sig_structure` from the bare protected/payload
 * byte strings, so the signed bytes must be canonical. `cbor-x` would tag `Map`
 * (tag 259) and `Uint8Array` (tag 64), which diverges from arbor's canonical
 * encoding and breaks verification. The grant payload goes through this
 * package's tag-free {@link ./encode-cbor-deterministic.ts}; `Sig_structure`
 * and Sign1 assembly (grant-builder) stream byte strings and text through the
 * helpers below. Unsigned integers stream through
 * {@link ./append-cbor-uint64.ts}.
 */

import type { Grant } from "./grant.js";
import { encodeGrantPayload } from "./grant-codec.js";

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
 * Canonical grant v0 payload CBOR (map keys 1-6, no idtimestamp), the bytes
 * arbor rebuilds the `Sig_structure` from. The same encoding as
 * {@link encodeGrantPayload}, kept under this name for grant-builder,
 * e2e-kit and forestrie-cli; `encodeCborDeterministic` is tag-free, so arbor
 * decodes `grantData` as a bare byte string.
 *
 * @throws When `maxHeight` or `minGrowth` is not a uint (see grant-codec.ts).
 */
export function encodeGrantPayloadV0Canonical(grant: Grant): Uint8Array {
  return encodeGrantPayload(grant);
}
