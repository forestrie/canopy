/**
 * POST /v1/api/keys — create custody ES256 key (application/cbor). Traefik → `/api/keys` on pod.
 */

import { decode as decodeCbor, encode as encodeCbor } from "cbor-x";
import {
  custodianBodyPreview,
  custodianDecodeCbor,
  custodianReadCborStringField,
} from "./custodian-api-cbor.js";
import { custodianApiV1BaseUrl } from "./custodian-api-env.js";
import { e2eCustodianKeyLabels } from "./e2e-custodian-labels.js";
import { assertUserLabelKeysNotOperatorPrefix } from "./forestrie-operator-labels.js";

export interface CustodianApiCreateKeyRequest {
  keyOwnerId: string;
  selfLogId: string;
  alg?: string;
  labels?: Record<string, string>;
}

export interface CustodianApiCreateKeyResponse {
  keyId: string;
  publicKeyPem: string;
  alg: string;
}

export async function postCustodianApiCreateEs256Key(opts: {
  baseUrl: string;
  appToken: string;
  body: CustodianApiCreateKeyRequest;
}): Promise<CustodianApiCreateKeyResponse> {
  const base = custodianApiV1BaseUrl(opts.baseUrl);
  const labels = {
    ...e2eCustodianKeyLabels(),
    ...opts.body.labels,
  };
  assertUserLabelKeysNotOperatorPrefix(labels);
  const cborBody: Record<string, unknown> = {
    keyOwnerId: opts.body.keyOwnerId,
    selfLogId: opts.body.selfLogId,
    alg: opts.body.alg ?? "ES256",
    labels,
  };
  const encoded = encodeCbor(cborBody);
  const u8 =
    encoded instanceof Uint8Array
      ? encoded
      : new Uint8Array(encoded as ArrayLike<number>);
  const bodyBuf = u8.buffer.slice(
    u8.byteOffset,
    u8.byteOffset + u8.byteLength,
  ) as ArrayBuffer;
  const res = await fetch(`${base}/api/keys`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${opts.appToken}`,
      "Content-Type": "application/cbor",
      Accept: "application/cbor",
    },
    body: bodyBuf,
  });
  const buf = new Uint8Array(await res.arrayBuffer());
  if (!res.ok) {
    throw new Error(
      `Custodian create key: ${res.status} ${custodianBodyPreview(buf)}`,
    );
  }
  const raw = custodianDecodeCbor(buf);
  const keyId = custodianReadCborStringField(raw, "keyId");
  const publicKey = custodianReadCborStringField(raw, "publicKey");
  const alg = custodianReadCborStringField(raw, "alg") || "ES256";
  if (!keyId || !publicKey) {
    throw new Error("Custodian create key: missing keyId or publicKey in CBOR");
  }
  return { keyId, publicKeyPem: publicKey, alg };
}
