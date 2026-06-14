/**
 * Delegation issuance helpers for coordinator e2e (custodial trust root).
 */

import { createPrivateKey, createPublicKey } from "node:crypto";
import { decode, Encoder } from "cbor-x";
import { encodeSigStructure } from "@canopy/encoding";
import { keccak_256 } from "@noble/hashes/sha3";
import { secp256k1 } from "@noble/curves/secp256k1";
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

/** Import ES256 bootstrap PEM as a WebCrypto key pair for delegation signing. */
export async function importEs256PemKeyPair(pem: string): Promise<CryptoKeyPair> {
  const privKeyObj = createPrivateKey({ key: pem, format: "pem" });
  const pkcs8 = privKeyObj.export({ format: "der", type: "pkcs8" });
  const privateKey = await crypto.subtle.importKey(
    "pkcs8",
    new Uint8Array(pkcs8).buffer as ArrayBuffer,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
  const pubDer = createPublicKey(privKeyObj).export({
    format: "der",
    type: "spki",
  });
  const publicKey = await crypto.subtle.importKey(
    "spki",
    new Uint8Array(pubDer).buffer as ArrayBuffer,
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["verify"],
  );
  return { privateKey, publicKey };
}

export async function uploadBootstrapKs256PublicRoot(opts: {
  coordinatorUrl: string;
  token: string;
  logId: string;
  address: Uint8Array;
}): Promise<Response> {
  if (opts.address.length !== 20) {
    throw new Error("KS256 bootstrap address must be 20 bytes");
  }
  return fetch(`${opts.coordinatorUrl}/api/logs/${opts.logId}/public-root`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${opts.token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      alg: -65799,
      key: bytesToBase64(opts.address),
    }),
  });
}

const COSE_ALG_KS256 = -65799;
const KS256_EOA_SIG_BYTES = 65;

function parseKs256PrivateKeyHex(raw: string): Uint8Array {
  const hex = raw.trim().replace(/^0x/, "");
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error(
      "KS256 bootstrap private key must be 32-byte hex (64 chars)",
    );
  }
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/** Build KS256 delegation material signed by contract bootstrap EOA key. */
export async function buildKs256BootstrapDelegationMaterial(opts: {
  rootSignerAddress: Uint8Array;
  privateKeyHex: string;
  logIdHex32: string;
  mmrStart: number;
  mmrEnd: number;
  delegatedPublicKey: Uint8Array;
  ttlSeconds?: number;
}): Promise<ByokDelegationMaterial> {
  if (opts.rootSignerAddress.length !== 20) {
    throw new Error("KS256 root signer address must be 20 bytes");
  }
  const issuedAt = Math.floor(Date.now() / 1000);
  const expiresAt = issuedAt + (opts.ttlSeconds ?? 3600);
  const delegatedKey = decodeDelegatedCoseKey(opts.delegatedPublicKey);

  const protectedBytes = cborBytes(
    new Map<number, unknown>([
      [1, COSE_ALG_KS256],
      [3, "application/forestrie.delegation+cbor"],
      [4, opts.rootSignerAddress],
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
  const hash = keccak_256(sigStructure);
  const sk = parseKs256PrivateKeyHex(opts.privateKeyHex);
  const sigObj = secp256k1.sign(hash, sk);
  const compact = sigObj.toCompactRawBytes();
  const recovery = sigObj.recovery ?? 0;
  const signature = new Uint8Array(KS256_EOA_SIG_BYTES);
  signature.set(compact, 0);
  signature[64] = 27 + recovery;

  const certificate = cborBytes([
    protectedBytes,
    new Map<string, unknown>(),
    payloadBytes,
    signature,
  ]);
  return { certificate, issuedAt, expiresAt };
}

export function verifyKs256BootstrapDelegationCertificate(opts: {
  certificate: Uint8Array;
  rootSignerAddress: Uint8Array;
}): boolean {
  if (opts.rootSignerAddress.length !== 20) {
    throw new Error("KS256 root signer address must be 20 bytes");
  }
  const cert = decode(opts.certificate) as unknown[];
  if (!Array.isArray(cert) || cert.length !== 4) {
    throw new Error("delegation certificate must be COSE_Sign1 array");
  }
  const protectedBytes = bytesFromUnknown(cert[0], "protected");
  const payloadBytes = bytesFromUnknown(cert[2], "payload");
  const signature = bytesFromUnknown(cert[3], "signature");
  if (signature.length !== KS256_EOA_SIG_BYTES) {
    return false;
  }
  const sigStructure = encodeSigStructure(
    protectedBytes,
    new Uint8Array(),
    payloadBytes,
  );
  const hash = keccak_256(sigStructure);
  const r = signature.slice(0, 32);
  const s = signature.slice(32, 64);
  let v = signature[64]!;
  if (v < 27) v += 27;
  const recovery = v - 27;
  if (recovery > 3) return false;
  try {
    const sig = secp256k1.Signature.fromCompact(
      new Uint8Array([...r, ...s]),
    ).addRecoveryBit(recovery);
    const pub = sig.recoverPublicKey(hash);
    const pubHash = keccak_256(pub.toRawBytes(false).slice(1));
    const recovered = pubHash.slice(-20);
    if (recovered.length !== opts.rootSignerAddress.length) return false;
    for (let i = 0; i < recovered.length; i++) {
      if (recovered[i] !== opts.rootSignerAddress[i]) return false;
    }
    return true;
  } catch {
    return false;
  }
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
