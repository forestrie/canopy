/**
 * Custodian POST /api/keys/{keyId}/sign with raw payload bytes (e2e).
 * Shared contract for :bootstrap (bootstrap token) and custody keys (app token).
 */

import { encode as encodeCbor } from "cbor-x";

function trimBase(url: string): string {
  return url.trim().replace(/\/$/, "");
}

export async function postCustodianSignRawPayloadBytes(opts: {
  baseUrl: string;
  bearerToken: string;
  keyIdSegment: string;
  payloadBytes: Uint8Array;
}): Promise<Uint8Array> {
  const base = trimBase(opts.baseUrl);
  const keySeg = encodeURIComponent(opts.keyIdSegment);
  const encoded = encodeCbor({ payload: opts.payloadBytes });
  const u8 =
    encoded instanceof Uint8Array
      ? encoded
      : new Uint8Array(encoded as ArrayLike<number>);
  const bodyBuf = u8.buffer.slice(
    u8.byteOffset,
    u8.byteOffset + u8.byteLength,
  ) as ArrayBuffer;
  const res = await fetch(`${base}/api/keys/${keySeg}/sign`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${opts.bearerToken}`,
      "Content-Type": "application/cbor",
      Accept: 'application/cose; cose-type="cose-sign1"',
    },
    body: bodyBuf,
  });
  if (!res.ok) {
    throw new Error(
      `Custodian sign failed: ${res.status} ${(await res.text()).slice(0, 200)}`,
    );
  }
  return new Uint8Array(await res.arrayBuffer());
}
