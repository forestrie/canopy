/**
 * POST /v1/api/keys/{keyId}/sign — COSE Sign1; verify with `@canopy/api` helpers.
 */

import { encode as encodeCbor } from "cbor-x";
import { verifyCustodianEs256GrantSign1 } from "../../../../apps/canopy-api/src/scrapi/custodian-grant.js";
import { custodianApiV1BaseUrl } from "./custodian-api-env.js";

export async function postCustodianApiSignPayload(opts: {
  baseUrl: string;
  appToken: string;
  keyIdSegment: string;
  payloadBytes: Uint8Array;
}): Promise<Uint8Array> {
  const base = custodianApiV1BaseUrl(opts.baseUrl);
  const keySeg = encodeURIComponent(opts.keyIdSegment);
  const cborBody = encodeCbor({ payload: opts.payloadBytes });
  const u8 =
    cborBody instanceof Uint8Array
      ? cborBody
      : new Uint8Array(cborBody as ArrayLike<number>);
  const bodyBuf = u8.buffer.slice(
    u8.byteOffset,
    u8.byteOffset + u8.byteLength,
  ) as ArrayBuffer;
  const res = await fetch(`${base}/api/keys/${keySeg}/sign`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${opts.appToken}`,
      "Content-Type": "application/cbor",
      Accept: 'application/cose; cose-type="cose-sign1"',
    },
    body: bodyBuf,
  });
  if (!res.ok) {
    throw new Error(
      `Custodian sign: ${res.status} ${(await res.text()).slice(0, 200)}`,
    );
  }
  return new Uint8Array(await res.arrayBuffer());
}

export async function verifyCustodianApiSign1AgainstPem(
  coseSign1: Uint8Array,
  publicKeyPem: string,
): Promise<boolean> {
  return verifyCustodianEs256GrantSign1(coseSign1, publicKeyPem);
}
