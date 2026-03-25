/**
 * Custodian HTTP client for grant signing (Plan 0014): RFC 8152 Sign1 from
 * POST /api/keys/{keyId}/sign; public key from GET /api/keys/{keyId}/public.
 * Custodian COSE payload is the 32-byte SHA-256 digest of the grant payload;
 * full grant bytes are carried in unprotected header HEADER_FORESTRIE_GRANT_V0.
 */

import { decode as decodeCbor, encode as encodeCbor } from "cbor-x";
import { verifyCoseSign1 } from "@canopy/encoding";
import {
  HEADER_FORESTRIE_GRANT_V0,
  HEADER_IDTIMESTAMP,
} from "../grant/transparent-statement.js";

export const CUSTODIAN_BOOTSTRAP_KEY_ID = ":bootstrap";

function trimBase(url: string): string {
  return url.trim().replace(/\/$/, "");
}

function readCborStringField(raw: unknown, field: string): string {
  if (raw instanceof Map) {
    for (const [k, v] of raw.entries()) {
      const ks = typeof k === "string" ? k : String(k);
      if (ks === field && typeof v === "string") return v;
    }
    return "";
  }
  if (raw && typeof raw === "object" && !(raw instanceof Uint8Array)) {
    const v = (raw as Record<string, unknown>)[field];
    return typeof v === "string" ? v : "";
  }
  return "";
}

function toHeaderMap(
  value: Map<number, unknown> | Record<string, unknown> | unknown,
): Map<number, unknown> {
  if (value instanceof Map) return new Map(value as Map<number, unknown>);
  if (
    typeof value === "object" &&
    value !== null &&
    !(value instanceof Uint8Array)
  ) {
    const out = new Map<number, unknown>();
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const n = Number(k);
      if (Number.isFinite(n)) out.set(n, v);
    }
    return out;
  }
  return new Map();
}

export interface CustodianPublicKeyResponse {
  keyId: string;
  publicKeyPem: string;
  alg: string;
}

/**
 * GET /api/keys/{keyId}/public — CBOR body keyId, publicKey (PEM), alg.
 */
export async function fetchCustodianPublicKey(
  custodianBaseUrl: string,
  keyId: string,
): Promise<CustodianPublicKeyResponse> {
  const base = trimBase(custodianBaseUrl);
  const enc = encodeURIComponent(keyId);
  const res = await fetch(`${base}/api/keys/${enc}/public`, {
    headers: { Accept: "application/cbor" },
  });
  if (!res.ok) {
    throw new Error(
      `Custodian public key fetch failed: ${res.status} ${await res.text()}`,
    );
  }
  const buf = new Uint8Array(await res.arrayBuffer());
  const raw = decodeCbor(buf) as unknown;
  const keyIdOut = readCborStringField(raw, "keyId");
  const publicKey = readCborStringField(raw, "publicKey");
  const alg = readCborStringField(raw, "alg");
  if (!publicKey.trim()) {
    throw new Error("Custodian public key response missing publicKey");
  }
  return { keyId: keyIdOut, publicKeyPem: publicKey, alg: alg || "ES256" };
}

/**
 * POST /api/keys/{keyId}/sign — CBOR body { payload: grantPayloadBytes }; Bearer token.
 * Returns raw COSE_Sign1 bytes (application/cose).
 */
export async function postCustodianSignGrantPayload(
  custodianBaseUrl: string,
  keyId: string,
  bearerToken: string,
  grantPayloadBytes: Uint8Array,
): Promise<Uint8Array> {
  const base = trimBase(custodianBaseUrl);
  const keySeg = encodeURIComponent(keyId);
  const cborBody = encodeCbor({ payload: grantPayloadBytes });
  const body =
    cborBody instanceof Uint8Array
      ? cborBody
      : new Uint8Array(cborBody as ArrayLike<number>);
  const res = await fetch(`${base}/api/keys/${keySeg}/sign`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${bearerToken}`,
      "Content-Type": "application/cbor",
      Accept: 'application/cose; cose-type="cose-sign1"',
    },
    body,
  });
  if (!res.ok) {
    throw new Error(`Custodian sign failed: ${res.status} ${await res.text()}`);
  }
  return new Uint8Array(await res.arrayBuffer());
}

/**
 * After Custodian returns Sign1 (payload = 32-byte digest), attach full grant
 * payload and bootstrap idtimestamp in unprotected headers for Forestrie-Grant decoding.
 */
export function mergeGrantHeadersIntoCustodianSign1(
  coseSign1Bytes: Uint8Array,
  grantPayloadBytes: Uint8Array,
): Uint8Array {
  const raw = decodeCbor(coseSign1Bytes) as unknown;
  const arr = Array.isArray(raw) ? raw : null;
  if (!arr || arr.length !== 4) {
    throw new Error("Invalid COSE Sign1 from Custodian");
  }
  const unprotected = toHeaderMap(arr[1]);
  unprotected.set(HEADER_FORESTRIE_GRANT_V0, grantPayloadBytes);
  unprotected.set(HEADER_IDTIMESTAMP, new Uint8Array(8));
  const next = [arr[0], unprotected, arr[2], arr[3]];
  return new Uint8Array(encodeCbor(next));
}

function pemBodyToDer(pem: string): Uint8Array {
  const base64 = pem
    .replace(/-----BEGIN [^-]+-----/g, "")
    .replace(/-----END [^-]+-----/g, "")
    .replace(/\s+/g, "");
  const bin = atob(base64);
  const der = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) der[i] = bin.charCodeAt(i);
  return der;
}

/**
 * Extract 65-byte uncompressed EC public key (04||x||y) from SPKI DER (P-256 / secp256k1 layout).
 */
function extractUncompressed65FromEcSpkiDer(der: Uint8Array): Uint8Array {
  for (let i = 0; i <= der.length - 68; i++) {
    if (
      der[i] === 0x03 &&
      der[i + 1] === 66 &&
      der[i + 2] === 0x00 &&
      der[i + 3] === 0x04
    ) {
      const key = new Uint8Array(65);
      key.set(der.subarray(i + 3, i + 68));
      return key;
    }
  }
  throw new Error("SPKI DER missing uncompressed EC BIT STRING (66 bytes)");
}

/** PEM SPKI → 65-byte uncompressed point (04||x||y). */
export function publicKeyPemToUncompressed65(pem: string): Uint8Array {
  return extractUncompressed65FromEcSpkiDer(pemBodyToDer(pem));
}

/**
 * Import SPKI PEM as Web Crypto ECDSA P-256 verify key (ES256).
 */
export async function importSpkiPemEs256VerifyKey(
  pem: string,
): Promise<CryptoKey> {
  const der = pemBodyToDer(pem);
  return crypto.subtle.importKey(
    "spki",
    der,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["verify"],
  );
}

/**
 * Verify RFC 8152 COSE Sign1 (ES256) using bootstrap/public key PEM from Custodian.
 */
export async function verifyCustodianEs256GrantSign1(
  coseSign1Bytes: Uint8Array,
  publicKeyPem: string,
): Promise<boolean> {
  const key = await importSpkiPemEs256VerifyKey(publicKeyPem);
  return verifyCoseSign1(coseSign1Bytes, key);
}

/**
 * Phase 2: sign grant payload with a custody key (APP_TOKEN).
 * Same wire shape as bootstrap; merges Forestrie unprotected headers.
 */
export async function signGrantPayloadWithCustodianCustodyKey(options: {
  custodianUrl: string;
  custodianAppToken: string;
  keyId: string;
  grantPayloadBytes: Uint8Array;
}): Promise<Uint8Array> {
  const raw = await postCustodianSignGrantPayload(
    options.custodianUrl,
    options.keyId,
    options.custodianAppToken,
    options.grantPayloadBytes,
  );
  return mergeGrantHeadersIntoCustodianSign1(raw, options.grantPayloadBytes);
}

