/**
 * COSE Sig_structure encoding (RFC 8152 / RFC 9052). Inlined here so the
 * package publishes standalone without `@canopy/encoding`; output must match
 * arbor delegationcert and canopy grant signing paths byte-for-byte.
 */

import { encodeCborBstr } from "./encode-cbor-bstr.js";

/** CBOR-encode a UTF-8 text string (major type 3). */
function encodeCborTstr(s: string): Uint8Array {
  const bytes = new TextEncoder().encode(s);
  const len = bytes.length;
  let header: Uint8Array;
  if (len < 24) {
    header = new Uint8Array([0x60 + len]);
  } else if (len < 256) {
    header = new Uint8Array([0x78, len]);
  } else {
    header = new Uint8Array([0x79, (len >> 8) & 0xff, len & 0xff]);
  }
  const out = new Uint8Array(header.length + bytes.length);
  out.set(header, 0);
  out.set(bytes, header.length);
  return out;
}

/** Concatenate byte arrays without allocation churn for small structures. */
function concat(...arrays: Uint8Array[]): Uint8Array {
  const total = arrays.reduce((sum, a) => sum + a.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const a of arrays) {
    out.set(a, off);
    off += a.length;
  }
  return out;
}

/**
 * Encode COSE Sign1 Sig_structure: `["Signature1", protected, AAD, payload]`.
 *
 * @param protectedHeaderMapBytes - Serialized protected header map (bstr body).
 * @param externalAad - External AAD; empty for Forestrie delegations.
 * @param payloadBstr - Serialized delegation payload (bstr body).
 * @returns Bytes hashed/signed by ES256 (SHA-256) or KS256 (keccak256).
 */
export function encodeSigStructure(
  protectedHeaderMapBytes: Uint8Array,
  externalAad: Uint8Array,
  payloadBstr: Uint8Array,
): Uint8Array {
  const arrayHeader = new Uint8Array([0x84]);
  const label = encodeCborTstr("Signature1");
  return concat(
    arrayHeader,
    label,
    encodeCborBstr(protectedHeaderMapBytes),
    encodeCborBstr(externalAad),
    encodeCborBstr(payloadBstr),
  );
}
