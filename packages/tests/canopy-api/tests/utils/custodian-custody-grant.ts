/**
 * Custodian custody key: POST /api/keys, sign grant payload with APP_TOKEN (Plan 0015).
 */

import { randomUUID } from "node:crypto";
import { decode as decodeCbor, encode as encodeCbor } from "cbor-x";
import { encodeGrantPayload } from "../../../../apps/canopy-api/src/grant/codec.js";
import type { Grant } from "../../../../apps/canopy-api/src/grant/types.js";
import {
  mergeGrantHeadersIntoCustodianSign1,
  postCustodianSignGrantPayload,
  publicKeyPemToUncompressed65,
} from "../../../../apps/canopy-api/src/scrapi/custodian-grant.js";
import { e2eCustodianKeyLabels } from "./e2e-custodian-labels.js";
import { normalizeForestrieHexId32 } from "./forestrie-hex-id.js";
import { assertUserLabelKeysNotOperatorPrefix } from "./forestrie-operator-labels.js";

export function custodianCustodySignEnv(): {
  baseUrl: string;
  token: string;
} | null {
  const baseUrl = process.env.CUSTODIAN_URL?.trim();
  const token = process.env.CUSTODIAN_APP_TOKEN?.trim();
  if (!baseUrl || !token) return null;
  return { baseUrl, token };
}

function trimBase(url: string): string {
  return url.trim().replace(/\/$/, "");
}

function grantData64FromUncompressed(u: Uint8Array): Uint8Array {
  if (u.length === 64) return u;
  if (u.length === 65 && u[0] === 0x04) return u.subarray(1, 65);
  throw new Error(
    `Expected 64-byte x||y or 65-byte 04||x||y; got length ${u.length}`,
  );
}

/**
 * KMS CryptoKey id Custodian uses for a log: 32 lowercase hex digits (optional hyphens in input).
 * Must match normalized `selfLogId` sent to `POST /api/keys`.
 */
export function custodianKmsCryptoKeyIdFromLogUuid(logId: string): string {
  return normalizeForestrieHexId32(logId);
}

/** Random 32-hex key owner id for e2e (distinct from self log id unless you reuse the same hex). */
export function e2eCustodianKeyOwnerId(): string {
  return custodianKmsCryptoKeyIdFromLogUuid(randomUUID());
}

/** ES256 **x‖y** (64 bytes) from Custodian PEM. */
export function grantData64FromCustodianPem(publicKeyPem: string): Uint8Array {
  const u65 = publicKeyPemToUncompressed65(publicKeyPem);
  return grantData64FromUncompressed(u65);
}

export async function postCustodianCreateEs256Key(opts: {
  baseUrl: string;
  appToken: string;
  /** Normalized by server; UUID or 32-hex accepted. */
  keyOwnerId: string;
  /**
   * Required. Log id as UUID or 32 hex; KMS CryptoKey id === {@link custodianKmsCryptoKeyIdFromLogUuid}(selfLogId).
   */
  selfLogId: string;
  /** Merged after e2e labels; must not use `fo-` prefix. */
  labels?: Record<string, string>;
}): Promise<{ keyId: string; publicKeyPem: string }> {
  const keyOwnerId = normalizeForestrieHexId32(opts.keyOwnerId);
  const selfLogId = normalizeForestrieHexId32(opts.selfLogId);
  const labels = {
    ...e2eCustodianKeyLabels(),
    ...opts.labels,
  };
  assertUserLabelKeysNotOperatorPrefix(labels);

  const base = trimBase(opts.baseUrl);
  const body: Record<string, unknown> = {
    keyOwnerId,
    selfLogId,
    alg: "ES256",
    labels,
  };
  const encoded = encodeCbor(body);
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
  if (!res.ok) {
    throw new Error(
      `Custodian create key: ${res.status} ${(await res.text()).slice(0, 200)}`,
    );
  }
  const raw = decodeCbor(new Uint8Array(await res.arrayBuffer())) as unknown;
  const fields =
    raw instanceof Map
      ? Object.fromEntries([...raw.entries()].map(([k, v]) => [String(k), v]))
      : (raw as Record<string, unknown>);
  const keyId = fields.keyId;
  const publicKey = fields.publicKey;
  if (typeof keyId !== "string" || typeof publicKey !== "string") {
    throw new Error("Custodian create key: missing keyId or publicKey");
  }
  return { keyId, publicKeyPem: publicKey };
}

/** Forestrie-Grant **base64** (Authorization value without prefix) for `Grant`. */
export async function signGrantPayloadWithCustodyKey(opts: {
  baseUrl: string;
  appToken: string;
  keyId: string;
  grant: Grant;
}): Promise<string> {
  const payloadBytes = encodeGrantPayload(opts.grant);
  const sign1Raw = await postCustodianSignGrantPayload(
    opts.baseUrl,
    opts.keyId,
    opts.appToken,
    payloadBytes,
  );
  const transparent = mergeGrantHeadersIntoCustodianSign1(
    sign1Raw,
    payloadBytes,
  );
  let s = "";
  for (let i = 0; i < transparent.length; i++)
    s += String.fromCharCode(transparent[i]!);
  return btoa(s);
}

export { authLogBootstrapShapedFlags } from "./e2e-grant-flags.js";
