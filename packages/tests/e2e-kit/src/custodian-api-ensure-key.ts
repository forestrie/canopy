/**
 * POST /v1/api/keys — ensure custody ES256 key (application/cbor). Traefik → `/api/keys` on pod.
 */

import { encodeCborDeterministic } from "@forestrie/encoding";
import {
  custodianBodyPreview,
  custodianDecodeCbor,
  custodianReadCborStringField,
} from "./custodian-api-cbor.js";
import { custodianApiV1BaseUrl } from "./custodian-api-env.js";
import { e2eCustodianKeyLabels } from "./e2e-custodian-labels.js";
import { e2eStaticCustodianKeyLabels } from "./e2e-static-log-ids.js";
import { assertUserLabelKeysNotOperatorPrefix } from "./forestrie-operator-labels.js";

export interface CustodianApiEnsureKeyRequest {
  keyOwnerId: string;
  selfLogId: string;
  alg?: string;
  protectionLevel?: string;
  labels?: Record<string, string>;
}

export interface CustodianApiEnsureKeyResponse {
  keyId: string;
  publicKeyPem: string;
  alg: string;
  created?: boolean;
}

export async function postCustodianApiEnsureEs256Key(opts: {
  baseUrl: string;
  appToken: string;
  body: CustodianApiEnsureKeyRequest;
}): Promise<CustodianApiEnsureKeyResponse> {
  const base = custodianApiV1BaseUrl(opts.baseUrl);
  const labels = {
    ...(opts.body.labels?.["e2e-static-key"] === "true"
      ? e2eStaticCustodianKeyLabels()
      : e2eCustodianKeyLabels()),
    ...opts.body.labels,
  };
  assertUserLabelKeysNotOperatorPrefix(labels);
  const cborBody: Record<string, unknown> = {
    keyOwnerId: opts.body.keyOwnerId,
    selfLogId: opts.body.selfLogId,
    alg: opts.body.alg ?? "ES256",
    protectionLevel: opts.body.protectionLevel ?? "SOFTWARE",
    labels,
  };
  const u8 = encodeCborDeterministic(cborBody);
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
      `Custodian ensure key: ${res.status} ${custodianBodyPreview(buf)}`,
    );
  }
  const raw = custodianDecodeCbor(buf);
  const keyId = custodianReadCborStringField(raw, "keyId");
  const publicKey = custodianReadCborStringField(raw, "publicKey");
  const alg = custodianReadCborStringField(raw, "alg") || "ES256";
  if (!keyId || !publicKey) {
    throw new Error("Custodian ensure key: missing keyId or publicKey in CBOR");
  }
  return { keyId, publicKeyPem: publicKey, alg };
}
