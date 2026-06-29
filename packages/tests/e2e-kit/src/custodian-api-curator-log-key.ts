/**
 * GET /v1/api/keys/curator/log-key?logId=…
 */

import {
  custodianBodyPreview,
  custodianDecodeCbor,
  custodianReadCborStringField,
} from "./custodian-api-cbor.js";
import { custodianApiV1BaseUrl } from "./custodian-api-env.js";

export async function getCustodianApiCuratorLogKey(opts: {
  baseUrl: string;
  appToken: string;
  logId: string;
}): Promise<{ status: number; keyId: string | null; body: Uint8Array }> {
  const base = custodianApiV1BaseUrl(opts.baseUrl);
  const url = `${base}/api/keys/curator/log-key?logId=${encodeURIComponent(opts.logId)}`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${opts.appToken}`,
      Accept: "application/cbor",
    },
  });
  const buf = new Uint8Array(await res.arrayBuffer());
  if (!res.ok) {
    return { status: res.status, keyId: null, body: buf };
  }
  const raw = custodianDecodeCbor(buf);
  const keyId = custodianReadCborStringField(raw, "keyId");
  if (!keyId) {
    throw new Error(
      `Custodian curator/log-key: missing keyId ${custodianBodyPreview(buf)}`,
    );
  }
  return { status: res.status, keyId, body: buf };
}
