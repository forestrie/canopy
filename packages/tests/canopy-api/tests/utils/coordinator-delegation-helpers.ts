/**
 * Delegation issuance helpers for coordinator e2e (custodial trust root).
 */

import { decode, encode as encodeCbor } from "cbor-x";
import { encodeSigStructure } from "@canopy/encoding";
import { custodianApiV1BaseUrl } from "./custodian-api-env.js";
import { custodianDecodeCbor } from "./custodian-api-cbor.js";
import { normalizeForestrieHexId32 } from "./forestrie-hex-id.js";

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
  const encoded = encodeCbor(coseMap);
  return encoded instanceof Uint8Array
    ? encoded
    : new Uint8Array(encoded as ArrayLike<number>);
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
  const encoded = encodeCbor(body);
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
  const delegatedKey = decode(opts.delegatedPublicKey) as unknown;

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
  const encoded = encodeCbor(value);
  return encoded instanceof Uint8Array
    ? encoded
    : new Uint8Array(encoded as ArrayLike<number>);
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
