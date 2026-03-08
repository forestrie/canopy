/**
 * Grant request CBOR encoder (artifact).
 * Contract: map with int keys 3=logId, 4=ownerLogId, 5=grantFlags, 8=grantData, 9=signer, 10=kind; values bstr.
 */

import { encodeCborBstr } from "./encode-cbor-bstr.js";

/** Grant request CBOR key labels (match API parseGrantRequest). */
export const GRANT_REQUEST_KEYS = {
  logId: 3,
  ownerLogId: 4,
  grantFlags: 5,
  grantData: 8,
  signer: 9,
  kind: 10,
} as const;

export interface GrantRequestInput {
  logId: Uint8Array;
  ownerLogId: Uint8Array;
  grantFlags: Uint8Array;
  grantData: Uint8Array;
  signer: Uint8Array;
  kind: Uint8Array;
}

/**
 * Encode grant request as CBOR map (keys 3,4,5,8,9,10; values bstr).
 * Single canonical encoder for POST /logs/{logId}/grants body.
 */
export function encodeGrantRequest(input: GrantRequestInput): Uint8Array {
  const K = GRANT_REQUEST_KEYS;
  const pairs: [number, Uint8Array][] = [
    [K.logId, input.logId],
    [K.ownerLogId, input.ownerLogId],
    [K.grantFlags, input.grantFlags],
    [K.grantData, input.grantData],
    [K.signer, input.signer],
    [K.kind, input.kind],
  ];
  const mapHeader = new Uint8Array([0xa6]); // map(6)
  const chunks: Uint8Array[] = [mapHeader];
  for (const [key, val] of pairs) {
    chunks.push(new Uint8Array([key]));
    chunks.push(encodeCborBstr(val));
  }
  const total = chunks.reduce((sum, c) => sum + c.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}
