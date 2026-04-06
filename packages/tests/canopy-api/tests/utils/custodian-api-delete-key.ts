/**
 * POST /v1/api/keys/{keyId}/delete — requires **bootstrap app token** (privileged lifecycle).
 */

import {
  custodianBodyPreview,
  custodianDecodeCbor,
  custodianReadCborIntField,
  custodianReadCborStringField,
} from "./custodian-api-cbor.js";
import { custodianApiV1BaseUrl } from "./custodian-api-env.js";

export interface CustodianApiDeleteKeyResponse {
  keyId: string;
  destroyedCount: number;
}

export async function postCustodianApiDeleteKey(opts: {
  baseUrl: string;
  bootstrapAppToken: string;
  keyIdSegment: string;
}): Promise<CustodianApiDeleteKeyResponse> {
  const base = custodianApiV1BaseUrl(opts.baseUrl);
  const seg = encodeURIComponent(opts.keyIdSegment);
  const res = await fetch(`${base}/api/keys/${seg}/delete`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${opts.bootstrapAppToken}`,
      Accept: "application/cbor",
    },
  });
  const buf = new Uint8Array(await res.arrayBuffer());
  if (!res.ok) {
    throw new Error(
      `Custodian delete key: ${res.status} ${custodianBodyPreview(buf)}`,
    );
  }
  const raw = custodianDecodeCbor(buf);
  const keyId = custodianReadCborStringField(raw, "keyId");
  const destroyed = custodianReadCborIntField(raw, "destroyedCount");
  if (!keyId || destroyed === undefined) {
    throw new Error("Custodian delete key: missing keyId or destroyedCount");
  }
  return { keyId, destroyedCount: destroyed };
}
