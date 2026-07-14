/**
 * Delegation issuance helpers for coordinator e2e (custodial trust root).
 */

import { createPrivateKey, createPublicKey } from "node:crypto";
import {
  decodeCborDeterministic,
  encodeCborDeterministic,
  parseRegistrarKeyXY,
  verifyDelegateKeyVoucher,
} from "@forestrie/encoding";
import {
  buildDelegationCertificateEs256,
  buildDelegationCertificateKs256,
  decodeDelegatedCoseKeyFromBytes,
  parseDelegatedCoseKeyFromPayload,
  parseDelegationCertificate,
  signOnchainDelegationEs256,
  signOnchainDelegationKs256,
  verifyDelegationCertificateEs256,
  verifyDelegationCertificateKs256,
} from "@forestrie/delegation-cose";
import { cborIntKeyBytes } from "./cbor-int-key.js";
import { custodianApiV1BaseUrl } from "./custodian-api-env.js";
import { custodianDecodeCbor } from "./custodian-api-cbor.js";
import { normalizeForestrieHexId32 } from "./forestrie-hex-id.js";

function cborBytes(value: unknown): Uint8Array {
  return cborIntKeyBytes(value);
}

/**
 * Normalize a decoded CBOR value to a string-keyed record. The deterministic
 * decoder always yields a `Map` for CBOR maps; server responses here use
 * string keys.
 */
function cborMapToRecord(raw: unknown): Record<string, unknown> {
  if (raw instanceof Map) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of raw.entries()) out[String(k)] = v;
    return out;
  }
  return (raw ?? {}) as Record<string, unknown>;
}

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

function base64ToBytes(b64: string): Uint8Array {
  return new Uint8Array(Buffer.from(b64, "base64"));
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
  /**
   * Root's signature over the univocity on-chain delegation Sig_structure,
   * submitted as `onchainSignature` so the coordinator can return
   * `onchainProof` to the sealer (plan-2607-10). The contract requires this
   * proof whenever a delegated key signed the checkpoint receipt, regardless
   * of root algorithm, so every BYOK material builder populates it: KS256
   * roots produce 65-byte `r‖s‖v` (keccak256 digest), ES256 roots 64-byte
   * IEEE P1363 `r‖s` (SHA-256 digest, low-s normalized).
   */
  onchainSignature?: Uint8Array;
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
  const encoded = encodeCborDeterministic(body);
  const u8 =
    encoded instanceof Uint8Array
      ? encoded
      : new Uint8Array(encoded as ArrayLike<number>);
  const res = await fetch(`${base}/api/delegations`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${opts.appToken}`,
      "Content-Type": "application/cbor",
      Accept: "application/cbor",
    },
    body: toArrayBuffer(u8),
  });
  const buf = new Uint8Array(await res.arrayBuffer());
  if (!res.ok) {
    const preview =
      buf.byteLength > 0
        ? Buffer.from(buf).toString("utf8").slice(0, 300)
        : "(empty)";
    throw new Error(
      `Custodian delegation issue: ${res.status} (${buf.byteLength} bytes): ${preview}`,
    );
  }
  const raw = cborMapToRecord(custodianDecodeCbor(buf));
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
  const raw = cborMapToRecord(decodeCborDeterministic(buf));
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
  logId: string;
  /** @deprecated public-root GET is unauthenticated */
  token?: string;
}): Promise<CoordinatorTrustRootCbor> {
  const res = await fetch(
    `${opts.coordinatorUrl}/api/logs/${opts.logId}/public-root`,
    {
      method: "GET",
      headers: {
        Accept: "application/cbor",
      },
    },
  );
  const buf = new Uint8Array(await res.arrayBuffer());
  if (!res.ok) {
    throw new Error(`GET public-root: ${res.status} (${buf.byteLength} bytes)`);
  }
  const raw = cborMapToRecord(decodeCborDeterministic(buf));
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
export async function importEs256PemKeyPair(
  pem: string,
): Promise<CryptoKeyPair> {
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
  const certificate = await buildDelegationCertificateKs256(
    {
      logIdHex32: opts.logIdHex32,
      mmrStart: opts.mmrStart,
      mmrEnd: opts.mmrEnd,
      delegatedPublicKeyCbor: opts.delegatedPublicKey,
      ttlSeconds: opts.ttlSeconds,
    },
    opts.rootSignerAddress,
    opts.privateKeyHex,
  );
  const info = parseDelegationCertificate(certificate);
  const delegated = parseDelegatedCoseKeyFromPayload(
    decodeDelegatedCoseKeyFromBytes(opts.delegatedPublicKey),
  );
  const onchainProof = signOnchainDelegationKs256(
    {
      logIdHex: opts.logIdHex32,
      mmrStart: opts.mmrStart,
      mmrEnd: opts.mmrEnd,
      delegatedKeyX: delegated.x,
      delegatedKeyY: delegated.y,
    },
    opts.privateKeyHex,
  );
  return {
    certificate,
    issuedAt: info.issuedAt,
    expiresAt: info.expiresAt,
    onchainSignature: onchainProof.signature,
  };
}

export async function verifyKs256BootstrapDelegationCertificate(opts: {
  certificate: Uint8Array;
  rootSignerAddress: Uint8Array;
}): Promise<boolean> {
  if (opts.rootSignerAddress.length !== 20) {
    throw new Error("KS256 root signer address must be 20 bytes");
  }
  return verifyDelegationCertificateKs256(
    opts.certificate,
    opts.rootSignerAddress,
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
  const certificate = await buildDelegationCertificateEs256(
    {
      logIdHex32: opts.logIdHex32,
      mmrStart: opts.mmrStart,
      mmrEnd: opts.mmrEnd,
      delegatedPublicKeyCbor: opts.delegatedPublicKey,
      ttlSeconds: opts.ttlSeconds,
    },
    opts.rootKeyPair,
  );
  const info = parseDelegationCertificate(certificate);
  const delegated = parseDelegatedCoseKeyFromPayload(
    decodeDelegatedCoseKeyFromBytes(opts.delegatedPublicKey),
  );
  const onchainProof = await signOnchainDelegationEs256(
    {
      logIdHex: opts.logIdHex32,
      mmrStart: opts.mmrStart,
      mmrEnd: opts.mmrEnd,
      delegatedKeyX: delegated.x,
      delegatedKeyY: delegated.y,
    },
    opts.rootKeyPair,
  );
  return {
    certificate,
    issuedAt: info.issuedAt,
    expiresAt: info.expiresAt,
    onchainSignature: onchainProof.signature,
  };
}

export async function verifyByokDelegationCertificate(opts: {
  certificate: Uint8Array;
  rootPublicKey: CryptoKey;
}): Promise<boolean> {
  return verifyDelegationCertificateEs256(opts.certificate, opts.rootPublicKey);
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
}

type PendingDelegationRequest = {
  post: (
    url: string,
    options?: {
      headers?: Record<string, string>;
      data?: unknown;
    },
  ) => Promise<{
    status: () => number;
    ok: () => boolean;
    text: () => Promise<string>;
  }>;
};

/** Public per-log pending poll (sealer path; no bearer). */
export async function fetchLogPendingDelegation(opts: {
  request: PendingDelegationRequest & {
    get: (
      url: string,
      options?: { headers?: Record<string, string> },
    ) => Promise<{
      ok: () => boolean;
      status: () => number;
      json: () => Promise<unknown>;
    }>;
  };
  coordinatorUrl: string;
  logId: string;
}): Promise<{
  entries: Array<{
    logIdHex32: string;
    mmrStart: number;
    mmrEnd: number;
    delegatedPublicKey: string;
  }>;
}> {
  const res = await opts.request.get(
    `${opts.coordinatorUrl}/api/logs/${opts.logId}/pending-delegation`,
  );
  if (!res.ok()) {
    throw new Error(
      `GET pending-delegation: ${res.status()} ${JSON.stringify(await res.json())}`,
    );
  }
  return (await res.json()) as {
    entries: Array<{
      logIdHex32: string;
      mmrStart: number;
      mmrEnd: number;
      delegatedPublicKey: string;
    }>;
  };
}

/** Coordinator HTTP surface used by signAdvanceDelegation (Playwright-shaped). */
type AdvanceDelegationRequest = {
  get: (
    url: string,
    options?: { headers?: Record<string, string> },
  ) => Promise<{
    ok: () => boolean;
    status: () => number;
    json: () => Promise<unknown>;
  }>;
  post: (
    url: string,
    options?: { headers?: Record<string, string>; data?: unknown },
  ) => Promise<{
    ok: () => boolean;
    status: () => number;
    text: () => Promise<string>;
  }>;
};

export interface StandingDelegationEntry {
  delegatedPublicKey: string;
  suggestedTtlSeconds?: number;
  mmrStart?: number;
  /** Custodian voucher + attested identity for the standing key (FOR-390 phase H). */
  voucher?: string;
  sealerId?: string;
  epoch?: number;
}

/**
 * signAdvanceDelegation — pre-delegate to the sealer's standing key (FOR-390
 * phase E). Reads the window-less standing entry (C3), signs BOTH artifacts
 * (COSE certificate + compact on-chain signature) binding it over
 * [0, horizonMmrEnd], and submits. Callable the moment a logId is known — no
 * pending demand needed, so first-seal latency drops to a coverage hit.
 *
 * The on-chain signature is REQUIRED (review V3): without it the sealer's lease
 * carries no OnchainProof and the publisher cannot publish the log's
 * checkpoints. The coordinator also rejects an advance submit without it (C5).
 */
export async function signAdvanceDelegation(opts: {
  request: AdvanceDelegationRequest;
  coordinatorUrl: string;
  logId: string;
  logIdHex32: string;
  rootKeyPair: CryptoKeyPair;
  horizonMmrEnd: number;
  ttlSeconds?: number;
  /**
   * Base64 x||y of the pinned registrar voucher key (FOR-390 phase I). When
   * set, the advertised standing key's custodian voucher is verified against
   * it BEFORE binding — so a compromised coordinator cannot induce a delegation
   * to a key the sealer does not control. Omit only in tests that predate the
   * voucher path.
   */
  pinnedRegistrarKey?: string;
}): Promise<{
  mmrStart: number;
  mmrEnd: number;
  delegatedPublicKey: string;
  expiresAt: number;
}> {
  const res = await opts.request.get(
    `${opts.coordinatorUrl}/api/logs/${opts.logId}/pending-delegation`,
  );
  if (!res.ok()) {
    throw new Error(`GET pending-delegation: ${res.status()}`);
  }
  const body = (await res.json()) as { entries: StandingDelegationEntry[] };
  // The standing entry is window-less (no mmrStart) and carries a suggested TTL.
  const standing = body.entries.find(
    (e) => e.suggestedTtlSeconds !== undefined && e.mmrStart === undefined,
  );
  if (!standing) {
    throw new Error(
      "no standing delegate-key entry for log — register a public root and a sealer delegate key first (C1/C3)",
    );
  }

  const delegatedPublicKey = base64ToBytes(standing.delegatedPublicKey);

  // Phase I (FOR-390): verify the custodian voucher against the pinned registrar
  // key before binding. This protects the signing decision — which precedes any
  // sealed artifact, so the self-authenticating-artifact property cannot cover
  // it — against a compromised coordinator advertising a rogue key.
  if (opts.pinnedRegistrarKey) {
    if (
      !standing.voucher ||
      standing.sealerId === undefined ||
      standing.epoch === undefined
    ) {
      throw new Error(
        "standing entry is missing its registrar voucher — refusing to bind",
      );
    }
    const pinned = parseRegistrarKeyXY(base64ToBytes(opts.pinnedRegistrarKey));
    if (!pinned) {
      throw new Error("pinnedRegistrarKey must be base64 x||y (64 bytes)");
    }
    const verdict = await verifyDelegateKeyVoucher(
      base64ToBytes(standing.voucher),
      pinned,
      {
        sealerId: standing.sealerId,
        epoch: standing.epoch,
        publicKey: delegatedPublicKey,
      },
    );
    if (!verdict.ok) {
      throw new Error(
        `registrar voucher failed verification (${verdict.reason}) — refusing to bind`,
      );
    }
  }
  const mmrStart = 0;
  const mmrEnd = opts.horizonMmrEnd;
  const material = await buildByokDelegationMaterial({
    rootKeyPair: opts.rootKeyPair,
    logIdHex32: opts.logIdHex32,
    mmrStart,
    mmrEnd,
    delegatedPublicKey,
    ttlSeconds: opts.ttlSeconds ?? standing.suggestedTtlSeconds,
  });
  if (!material.onchainSignature) {
    throw new Error("advance delegation requires the onchain signature");
  }

  const submit = await opts.request.post(
    `${opts.coordinatorUrl}/api/delegations/certificate`,
    {
      headers: { "Content-Type": "application/json" },
      data: {
        logId: opts.logId,
        mmrStart,
        mmrEnd,
        delegatedPublicKey: standing.delegatedPublicKey,
        certificate: bytesToBase64(material.certificate),
        issuedAt: material.issuedAt,
        expiresAt: material.expiresAt,
        onchainSignature: bytesToBase64(material.onchainSignature),
      },
    },
  );
  if (!submit.ok()) {
    throw new Error(
      `POST advance delegation: ${submit.status()} ${(await submit.text()).slice(0, 300)}`,
    );
  }
  return {
    mmrStart,
    mmrEnd,
    delegatedPublicKey: standing.delegatedPublicKey,
    expiresAt: material.expiresAt,
  };
}
