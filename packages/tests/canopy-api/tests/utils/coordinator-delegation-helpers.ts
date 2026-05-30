/**
 * Delegation issuance helpers for coordinator e2e (custodial trust root).
 */

import { decode, Encoder } from "cbor-x";
import { encodeSigStructure } from "@canopy/encoding";
import { custodianApiV1BaseUrl } from "./custodian-api-env.js";
import { custodianDecodeCbor } from "./custodian-api-cbor.js";
import { normalizeForestrieHexId32 } from "./forestrie-hex-id.js";

const cborEncoder = new Encoder({ mapsAsObjects: false });

export function hex32ToWireLogId(hex32: string): Uint8Array {
  const h = normalizeForestrieHexId32(hex32);
  const out = new Uint8Array(16);
  for (let i = 0; i < 16; i++) {
    out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/** COSE_Key (EC2, P-256) CBOR bytes for a freshly generated delegated key. */
export async function generateEphemeralDelegatedPublicKeyCbor(): Promise<Uint8Array> {
  const keyPair = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );
  const raw = new Uint8Array(
    await crypto.subtle.exportKey("raw", keyPair.publicKey),
  );
  if (raw.length !== 65 || raw[0] !== 0x04) {
    throw new Error("expected uncompressed P-256 public key");
  }
  const x = raw.slice(1, 33);
  const y = raw.slice(33, 65);
  const coseMap = new Map<number, unknown>([
    [1, 2],
    [-1, 1],
    [-2, x],
    [-3, y],
  ]);
  return cborBytes(coseMap);
}

export function bytesToBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

export interface CustodianDelegationIssueResult {
  certificate: Uint8Array;
  issuedAt: number;
  expiresAt: number;
}

export interface ByokDelegationMaterial {
  certificate: Uint8Array;
  issuedAt: number;
  expiresAt: number;
}

/** POST /v1/api/delegations — local KMS sign or coordinator proxy. */
export async function postCustodianDelegationIssue(opts: {
  custodianBaseUrl: string;
  appToken: string;
  logIdHex32: string;
  mmrStart: number;
  mmrEnd: number;
  delegatedPublicKey: Uint8Array;
  requestedTtlSeconds?: number;
}): Promise<CustodianDelegationIssueResult> {
  const base = custodianApiV1BaseUrl(opts.custodianBaseUrl);
  const body = {
    version: 1,
    logId: hex32ToWireLogId(opts.logIdHex32),
    mmrStart: opts.mmrStart,
    mmrEnd: opts.mmrEnd,
    algorithm: "ES256",
    delegatedPublicKey: opts.delegatedPublicKey,
    requestedTtlSeconds: opts.requestedTtlSeconds ?? 3600,
  };
  const encoded = cborBytes(body);
  const u8 =
    encoded instanceof Uint8Array
      ? encoded
      : new Uint8Array(encoded as ArrayLike<number>);
  const bodyBuf = u8.buffer.slice(
    u8.byteOffset,
    u8.byteOffset + u8.byteLength,
  ) as ArrayBuffer;
  const res = await fetch(`${base}/api/delegations`, {
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
      `Custodian delegation issue: ${res.status} (${buf.byteLength} bytes)`,
    );
  }
  const raw = custodianDecodeCbor(buf) as Record<string, unknown>;
  const cert = raw.certificate;
  let certificate: Uint8Array;
  if (cert instanceof Uint8Array) {
    certificate = cert;
  } else if (ArrayBuffer.isView(cert)) {
    certificate = new Uint8Array(cert.buffer, cert.byteOffset, cert.byteLength);
  } else {
    throw new Error("Custodian delegation issue: missing certificate");
  }
  const issuedAt = Number(raw.issuedAt ?? 0);
  const expiresAt = Number(raw.expiresAt ?? 0);
  return { certificate, issuedAt, expiresAt };
}

export function decodeCoordinatorDelegationIssue(
  buf: Uint8Array,
): CustodianDelegationIssueResult {
  const raw = decode(buf) as Record<string, unknown>;
  const cert = raw.certificate;
  if (!(cert instanceof Uint8Array)) {
    throw new Error("coordinator issue response missing certificate bytes");
  }
  return {
    certificate: cert,
    issuedAt: Number(raw.issuedAt ?? 0),
    expiresAt: Number(raw.expiresAt ?? 0),
  };
}

/** P-256 root public key coordinates from a CryptoKeyPair (64-byte x||y). */
export async function exportEs256RootXy(
  keyPair: CryptoKeyPair,
): Promise<{ x: Uint8Array; y: Uint8Array }> {
  const raw = new Uint8Array(
    await crypto.subtle.exportKey("raw", keyPair.publicKey),
  );
  if (raw.length !== 65 || raw[0] !== 0x04) {
    throw new Error("expected uncompressed P-256 public key");
  }
  return { x: raw.slice(1, 33), y: raw.slice(33, 65) };
}

export async function importEs256PublicKeyFromXy(
  x: Uint8Array,
  y: Uint8Array,
): Promise<CryptoKey> {
  if (x.length !== 32 || y.length !== 32) {
    throw new Error("x and y must be 32 bytes");
  }
  const raw = new Uint8Array(65);
  raw[0] = 0x04;
  raw.set(x, 1);
  raw.set(y, 33);
  return crypto.subtle.importKey(
    "raw",
    toArrayBuffer(raw),
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["verify"],
  );
}

export interface CoordinatorTrustRootCbor {
  logId: Uint8Array;
  alg: string;
  x: Uint8Array;
  y: Uint8Array;
  chainId?: string;
  contractAddress?: string;
  domain?: string;
}

export async function uploadByokRootPublicKey(opts: {
  coordinatorUrl: string;
  token: string;
  logId: string;
  x: Uint8Array;
  y: Uint8Array;
}): Promise<Response> {
  return fetch(`${opts.coordinatorUrl}/api/logs/${opts.logId}/public-root`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${opts.token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      alg: "ES256",
      x: bytesToBase64(opts.x),
      y: bytesToBase64(opts.y),
    }),
  });
}

export async function fetchCoordinatorPublicRoot(opts: {
  coordinatorUrl: string;
  token: string;
  logId: string;
}): Promise<CoordinatorTrustRootCbor> {
  const res = await fetch(
    `${opts.coordinatorUrl}/api/logs/${opts.logId}/public-root`,
    {
      method: "GET",
      headers: {
        Authorization: `Bearer ${opts.token}`,
        Accept: "application/cbor",
      },
    },
  );
  const buf = new Uint8Array(await res.arrayBuffer());
  if (!res.ok) {
    throw new Error(`GET public-root: ${res.status} (${buf.byteLength} bytes)`);
  }
  const raw = decode(buf) as Record<string, unknown>;
  const logId = raw.logId;
  const x = raw.x;
  const y = raw.y;
  if (!(logId instanceof Uint8Array)) {
    throw new Error("public-root response missing logId bytes");
  }
  if (!(x instanceof Uint8Array) || !(y instanceof Uint8Array)) {
    throw new Error("public-root response missing x or y bytes");
  }
  return {
    logId,
    alg: String(raw.alg ?? ""),
    x,
    y,
    chainId: raw.chainId !== undefined ? String(raw.chainId) : undefined,
    contractAddress:
      raw.contractAddress !== undefined
        ? String(raw.contractAddress)
        : undefined,
    domain: raw.domain !== undefined ? String(raw.domain) : undefined,
  };
}

export async function generateEs256RootKeyPair(): Promise<CryptoKeyPair> {
  return crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );
}

export async function buildByokDelegationMaterial(opts: {
  rootKeyPair: CryptoKeyPair;
  logIdHex32: string;
  mmrStart: number;
  mmrEnd: number;
  delegatedPublicKey: Uint8Array;
  ttlSeconds?: number;
}): Promise<ByokDelegationMaterial> {
  const issuedAt = Math.floor(Date.now() / 1000);
  const expiresAt = issuedAt + (opts.ttlSeconds ?? 3600);
  const rawRoot = new Uint8Array(
    await crypto.subtle.exportKey("raw", opts.rootKeyPair.publicKey),
  );
  const kid = new Uint8Array(
    await crypto.subtle.digest("SHA-256", rawRoot),
  ).slice(0, 16);
  const delegatedKey = decodeDelegatedCoseKey(opts.delegatedPublicKey);

  const protectedBytes = cborBytes(
    new Map<number, unknown>([
      [1, -7],
      [3, "application/forestrie.delegation+cbor"],
      [4, kid],
    ]),
  );
  const payloadBytes = cborBytes(
    new Map<number, unknown>([
      [1, normalizeForestrieHexId32(opts.logIdHex32)],
      [3, opts.mmrStart],
      [4, opts.mmrEnd],
      [5, delegatedKey],
      [6, new Map<string, unknown>()],
      [7, 1],
      [8, issuedAt],
      [9, expiresAt],
      [10, crypto.getRandomValues(new Uint8Array(16))],
    ]),
  );
  const sigStructure = encodeSigStructure(
    protectedBytes,
    new Uint8Array(),
    payloadBytes,
  );
  const signature = new Uint8Array(
    await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      opts.rootKeyPair.privateKey,
      toArrayBuffer(sigStructure),
    ),
  );
  if (signature.byteLength !== 64) {
    throw new Error(
      `expected P-256 signature to be 64 bytes, got ${signature.byteLength}`,
    );
  }
  const certificate = cborBytes([
    protectedBytes,
    new Map<string, unknown>(),
    payloadBytes,
    signature,
  ]);
  return { certificate, issuedAt, expiresAt };
}

export async function verifyByokDelegationCertificate(opts: {
  certificate: Uint8Array;
  rootPublicKey: CryptoKey;
}): Promise<boolean> {
  const cert = decode(opts.certificate) as unknown[];
  if (!Array.isArray(cert) || cert.length !== 4) {
    throw new Error("delegation certificate must be COSE_Sign1 array");
  }
  const protectedBytes = bytesFromUnknown(cert[0], "protected");
  const payloadBytes = bytesFromUnknown(cert[2], "payload");
  const signature = bytesFromUnknown(cert[3], "signature");
  const sigStructure = encodeSigStructure(
    protectedBytes,
    new Uint8Array(),
    payloadBytes,
  );
  return crypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    opts.rootPublicKey,
    toArrayBuffer(signature),
    toArrayBuffer(sigStructure),
  );
}

function cborBytes(value: unknown): Uint8Array {
  const encoded = cborEncoder.encode(value);
  return encoded instanceof Uint8Array
    ? encoded
    : new Uint8Array(encoded as ArrayLike<number>);
}

function decodeDelegatedCoseKey(bytes: Uint8Array): Map<number, unknown> {
  const raw = decode(bytes) as unknown;
  if (raw instanceof Map) {
    return new Map(
      [...raw.entries()].map(([key, value]) => [Number(key), value]),
    );
  }
  if (raw && typeof raw === "object") {
    const out = new Map<number, unknown>();
    for (const [key, value] of Object.entries(raw)) {
      const numericKey = Number(key);
      if (!Number.isInteger(numericKey)) {
        throw new Error(`delegated COSE_Key has non-integer key ${key}`);
      }
      out.set(numericKey, value);
    }
    return out;
  }
  throw new Error("delegated COSE_Key is not a map");
}

function bytesFromUnknown(value: unknown, label: string): Uint8Array {
  if (value instanceof Uint8Array) return value;
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  throw new Error(`${label} is not bytes`);
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
}
