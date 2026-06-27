/**
 * COSE Sig_structure encoding (RFC 8152).
 * `["Signature1", protected_bstr, external_aad, payload_bstr]` — must match
 * arbor Custodian signing and {@link verifyCoseSign1} verification bytes.
 */

import { encodeCborBstr } from "./encode-cbor-bstr.js";

/** Encode a UTF-8 string as a CBOR text string (major type 3). */
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

/** Concatenate byte arrays without copying intermediate buffers. */
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
 * Encode Sig_structure for COSE Sign1 (RFC 8152 / RFC 9052).
 * Same bytes as veraison/go-cose `Sign1Message.toBeSigned` and Custodian signing.
 *
 * @param protectedHeaderMapBytes — CBOR map bytes inside Sign1 `protected` (the bstr
 *   **contents** from COSE_Sign1[0], not a pre-wrapped bstr item).
 * @param externalAad — Additional authenticated data (empty for Forestrie statements)
 * @param payloadBstr — Payload bytes as they appear in Sig_structure (may be detached)
 * @returns CBOR Sig_structure bytes hashed/signed by ES256 verify paths
 */
export function encodeSigStructure(
  protectedHeaderMapBytes: Uint8Array,
  externalAad: Uint8Array,
  payloadBstr: Uint8Array,
): Uint8Array {
  const arrayHeader = new Uint8Array([0x84]); // array(4)
  const label = encodeCborTstr("Signature1");
  return concat(
    arrayHeader,
    label,
    encodeCborBstr(protectedHeaderMapBytes),
    encodeCborBstr(externalAad),
    encodeCborBstr(payloadBstr),
  );
}
