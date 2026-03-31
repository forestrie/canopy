/**
 * Custodian custody key: POST /api/keys, sign grant payload with APP_TOKEN (Plan 0015).
 */

import { decode as decodeCbor, encode as encodeCbor } from "cbor-x";
import { encodeGrantPayload } from "../../../../apps/canopy-api/src/grant/codec.js";
import type { Grant } from "../../../../apps/canopy-api/src/grant/types.js";
import {
  mergeGrantHeadersIntoCustodianSign1,
  postCustodianSignGrantPayload,
  publicKeyPemToUncompressed65,
} from "../../../../apps/canopy-api/src/scrapi/custodian-grant.js";

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
 * KMS CryptoKey id Custodian uses for a log: RFC-4122 UUID with hyphens removed
 * (32 lowercase hex digits). Must match `selfLogId` sent to `POST /api/keys`.
 */
export function custodianKmsCryptoKeyIdFromLogUuid(logId: string): string {
  const compact = logId.trim().replace(/-/g, "").toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(compact)) {
    throw new Error(
      `selfLogId must be a UUID (32 hex digits); got length ${compact.length}`,
    );
  }
  return compact;
}

/** ES256 **x‖y** (64 bytes) from Custodian PEM. */
export function grantData64FromCustodianPem(publicKeyPem: string): Uint8Array {
  const u65 = publicKeyPemToUncompressed65(publicKeyPem);
  return grantData64FromUncompressed(u65);
}

export async function postCustodianCreateEs256Key(opts: {
  baseUrl: string;
  appToken: string;
  keyOwnerId: string;
  /**
   * Required. RFC-4122 log id; Custodian rejects create without a valid UUID (400).
   * KMS CryptoKey id === {@link custodianKmsCryptoKeyIdFromLogUuid}(selfLogId).
   */
  selfLogId: string;
}): Promise<{ keyId: string; publicKeyPem: string }> {
  const base = trimBase(opts.baseUrl);
  const body: Record<string, unknown> = {
    keyOwnerId: opts.keyOwnerId,
    selfLogId: opts.selfLogId,
    alg: "ES256",
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

/** Bitmap: GF_CREATE|GF_EXTEND (byte 4), GF_AUTH_LOG (byte 7). */
export function authLogBootstrapShapedFlags(): Uint8Array {
  const grant = new Uint8Array(8);
  grant[4] = 0x03;
  grant[7] = 0x01;
  return grant;
}
