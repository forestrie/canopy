/**
 * GET /v1/api/keys/{keyId}/public — optional `log-id=true` query.
 */

import {
  custodianBodyPreview,
  custodianDecodeCbor,
  custodianReadCborStringField,
} from "./custodian-api-cbor.js";
import { custodianApiV1BaseUrl } from "./custodian-api-env.js";

export interface CustodianApiPublicKeyResponse {
  keyId: string;
  publicKeyPem: string;
  alg: string;
}

export async function getCustodianApiPublicKey(opts: {
  baseUrl: string;
  keyIdSegment: string;
  logIdQuery?: boolean;
}): Promise<CustodianApiPublicKeyResponse> {
  const base = custodianApiV1BaseUrl(opts.baseUrl);
  const seg = encodeURIComponent(opts.keyIdSegment);
  const q = opts.logIdQuery ? "?log-id=true" : "";
  const res = await fetch(`${base}/api/keys/${seg}/public${q}`, {
    headers: { Accept: "application/cbor" },
  });
  const buf = new Uint8Array(await res.arrayBuffer());
  if (!res.ok) {
    throw new Error(
      `Custodian public key: ${res.status} ${custodianBodyPreview(buf)}`,
    );
  }
  const raw = custodianDecodeCbor(buf);
  const keyId = custodianReadCborStringField(raw, "keyId");
  const publicKey = custodianReadCborStringField(raw, "publicKey");
  const alg = custodianReadCborStringField(raw, "alg") || "ES256";
  if (!publicKey.trim()) {
    throw new Error("Custodian public key: missing publicKey");
  }
  return { keyId, publicKeyPem: publicKey, alg };
}
