/**
 * Custodian HTTP client for grant signing (Plan 0014): RFC 8152 Sign1 from
 * POST /api/keys/{keyId}/sign; public key from GET /api/keys/{keyId}/public.
 * Custodian COSE payload is the 32-byte SHA-256 digest of the grant payload;
 * full grant bytes are carried in unprotected header HEADER_FORESTRIE_GRANT_V0.
 */

import { decode as decodeCbor, encode as encodeCbor } from "cbor-x";
import {
  algToCurve,
  COSE_ALG_ES256,
  COSE_ALG_ES256K,
  decodeCoseSign1,
  extractAlgFromProtected,
  type ParsedEcPublicKey,
  type ParsedVerifyKey,
  type VerifyCoseSign1Options,
  verifyCoseSign1,
  verifyCoseSign1WithParsedKey,
} from "@canopy/encoding";
import {
  HEADER_FORESTRIE_GRANT_V0,
  HEADER_IDTIMESTAMP,
} from "../grant/transparent-statement.js";

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
/**
 * GET /api/keys/curator/log-key?logId=… — normal app token; CBOR { keyId }.
 * Custodian expects `logId` as 32-char lowercase hex (16-byte log id, no hyphens).
 */
export async function fetchCustodianCuratorLogKey(
  custodianBaseUrl: string,
  bearerToken: string,
  logIdLowerHex32: string,
): Promise<string> {
  const base = trimBase(custodianBaseUrl);
  const url = `${base}/api/keys/curator/log-key?logId=${encodeURIComponent(logIdLowerHex32)}`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${bearerToken}`,
      Accept: "application/cbor",
    },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(
      `Custodian curator/log-key failed: ${res.status} ${body.slice(0, 200)}`,
    );
  }
  const buf = new Uint8Array(await res.arrayBuffer());
  const raw = decodeCbor(buf) as unknown;
  const keyId = readCborStringField(raw, "keyId");
  if (!keyId) {
    throw new Error("Custodian curator/log-key response missing keyId");
  }
  return keyId;
}

export async function fetchCustodianPublicKey(
  custodianBaseUrl: string,
  keyId: string,
  options?: { logId?: boolean },
): Promise<CustodianPublicKeyResponse> {
  const base = trimBase(custodianBaseUrl);
  const enc = encodeURIComponent(keyId);
  const queryParam = options?.logId ? "?log-id=true" : "";
  const res = await fetch(`${base}/api/keys/${enc}/public${queryParam}`, {
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
  const u8 =
    cborBody instanceof Uint8Array
      ? cborBody
      : new Uint8Array(cborBody as ArrayLike<number>);
  const bodyBuf = u8.buffer.slice(
    u8.byteOffset,
    u8.byteOffset + u8.byteLength,
  ) as ArrayBuffer;
  const res = await fetch(`${base}/api/keys/${keySeg}/sign`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${bearerToken}`,
      "Content-Type": "application/cbor",
      Accept: 'application/cose; cose-type="cose-sign1"',
    },
    body: bodyBuf,
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
  const der = new Uint8Array(pemBodyToDer(pem));
  return crypto.subtle.importKey(
    "spki",
    der,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["verify"],
  );
}

/** secp256k1 OID bytes in SPKI DER: 1.3.132.0.10 */
const SECP256K1_OID_BYTES = new Uint8Array([0x2b, 0x81, 0x04, 0x00, 0x0a]);

/**
 * Detect if SPKI DER contains secp256k1 OID.
 */
function isSecp256k1FromDer(der: Uint8Array): boolean {
  // Look for the OID bytes in the DER structure
  outer: for (let i = 0; i <= der.length - SECP256K1_OID_BYTES.length; i++) {
    for (let j = 0; j < SECP256K1_OID_BYTES.length; j++) {
      if (der[i + j] !== SECP256K1_OID_BYTES[j]) continue outer;
    }
    return true;
  }
  return false;
}

/**
 * Import SPKI PEM as a ParsedVerifyKey based on the algorithm.
 * For ES256 (P-256): returns a CryptoKey via Web Crypto.
 * For ES256K (secp256k1): returns a ParsedEcPublicKey with x, y coordinates.
 *
 * If alg is missing or ambiguous, auto-detects curve from SPKI OID.
 *
 * @param pem - SPKI PEM-encoded public key
 * @param alg - Algorithm string from Custodian ("ES256" or "ES256K"/"KS256")
 */
export async function importSpkiPemVerifyKeyWithAlg(
  pem: string,
  alg: string,
): Promise<ParsedVerifyKey> {
  const normalizedAlg = alg.toUpperCase().trim();
  const der = pemBodyToDer(pem);

  // Explicit ES256K/KS256 or auto-detect from DER when alg is missing/default
  const algSaysSecp256k1 =
    normalizedAlg === "ES256K" || normalizedAlg === "KS256";
  const derSaysSecp256k1 = isSecp256k1FromDer(der);

  // Use secp256k1 if either alg says so OR if alg is ambiguous and DER contains secp256k1 OID
  const useSecp256k1 =
    algSaysSecp256k1 ||
    (!normalizedAlg || normalizedAlg === "ES256" ? derSaysSecp256k1 : false);

  if (useSecp256k1) {
    // Extract x, y coordinates from PEM for secp256k1
    const uncompressed = extractUncompressed65FromEcSpkiDer(der);
    if (uncompressed[0] !== 0x04 || uncompressed.length !== 65) {
      throw new Error("Expected uncompressed EC point (04||x||y)");
    }
    const x = uncompressed.slice(1, 33);
    const y = uncompressed.slice(33, 65);
    return { x, y, curve: "secp256k1" } as ParsedEcPublicKey;
  }

  // P-256 (ES256) via Web Crypto
  return crypto.subtle.importKey(
    "spki",
    new Uint8Array(der),
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["verify"],
  );
}

// Re-export types for convenience
export type { ParsedEcPublicKey, ParsedVerifyKey };

/**
 * Verify RFC 8152 COSE Sign1 (ES256) using bootstrap/public key PEM from Custodian.
 */
export async function verifyCustodianEs256GrantSign1(
  coseSign1Bytes: Uint8Array,
  publicKeyPem: string,
  verifyOpts?: VerifyCoseSign1Options,
): Promise<boolean> {
  const key = await importSpkiPemEs256VerifyKey(publicKeyPem);
  return verifyCoseSign1(coseSign1Bytes, key, verifyOpts);
}

/**
 * Import P-256 verify key from ES256 **`grantData`**: uncompressed **x‖y** (64 bytes).
 */
export async function importEs256PublicKeyFromGrantDataXy64(
  xy: Uint8Array,
): Promise<CryptoKey> {
  if (xy.length !== 64) {
    throw new Error(
      "ES256 grantData must be 64 bytes (x||y) for raw public key import",
    );
  }
  const raw = new Uint8Array(65);
  raw[0] = 0x04;
  raw.set(xy, 1);
  return crypto.subtle.importKey(
    "raw",
    raw,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["verify"],
  );
}

/**
 * Child auth first grant: verify COSE Sign1 using the **subject** key in **`grantData`** (x‖y).
 * @deprecated Use verifyGrantCoseSign1WithGrantDataXy for multi-curve support.
 */
export async function verifyCustodianEs256GrantSign1WithGrantDataXy(
  coseSign1Bytes: Uint8Array,
  grantDataXy64: Uint8Array,
  verifyOpts?: VerifyCoseSign1Options,
): Promise<boolean> {
  const key = await importEs256PublicKeyFromGrantDataXy64(grantDataXy64);
  return verifyCoseSign1(coseSign1Bytes, key, verifyOpts);
}

/**
 * Import verify key from 64-byte x||y based on COSE algorithm.
 * For ES256 (P-256): returns CryptoKey via Web Crypto.
 * For ES256K (secp256k1): returns ParsedEcPublicKey with x, y coordinates.
 */
export async function importVerifyKeyFromXy64WithAlg(
  xy: Uint8Array,
  alg: number,
): Promise<ParsedVerifyKey> {
  if (xy.length !== 64) {
    throw new Error("grantData must be 64 bytes (x||y) for public key import");
  }

  const curve = algToCurve(alg);
  if (curve === "secp256k1") {
    const x = xy.slice(0, 32);
    const y = xy.slice(32, 64);
    return { x, y, curve: "secp256k1" } as ParsedEcPublicKey;
  }

  // Default to P-256 (ES256) via Web Crypto
  const raw = new Uint8Array(65);
  raw[0] = 0x04;
  raw.set(xy, 1);
  return crypto.subtle.importKey(
    "raw",
    new Uint8Array(raw),
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["verify"],
  );
}

/**
 * Verify grant COSE Sign1 using grantData x||y (64 bytes).
 * Extracts `alg` from COSE protected header and uses appropriate curve.
 * Supports both ES256 (P-256) and ES256K (secp256k1).
 */
export async function verifyGrantCoseSign1WithGrantDataXy(
  coseSign1Bytes: Uint8Array,
  grantDataXy64: Uint8Array,
  verifyOpts?: VerifyCoseSign1Options,
): Promise<boolean> {
  // Decode to extract protected header
  const decoded = decodeCoseSign1(coseSign1Bytes);
  if (!decoded) {
    return false;
  }

  // Extract alg from protected header, default to ES256
  const alg = extractAlgFromProtected(decoded.protectedBstr) ?? COSE_ALG_ES256;

  // Import key based on algorithm
  const key = await importVerifyKeyFromXy64WithAlg(grantDataXy64, alg);

  // Verify using curve-aware function
  return verifyCoseSign1WithParsedKey(coseSign1Bytes, key, verifyOpts);
}

/**
 * Verify grant COSE Sign1 using PEM-encoded public key.
 * Extracts `alg` from COSE protected header and uses appropriate curve.
 * Supports both ES256 (P-256) and ES256K (secp256k1).
 */
export async function verifyGrantCoseSign1WithPem(
  coseSign1Bytes: Uint8Array,
  publicKeyPem: string,
  verifyOpts?: VerifyCoseSign1Options,
): Promise<boolean> {
  // Decode to extract protected header
  const decoded = decodeCoseSign1(coseSign1Bytes);
  if (!decoded) {
    return false;
  }

  // Extract alg from protected header, default to ES256
  const alg = extractAlgFromProtected(decoded.protectedBstr) ?? COSE_ALG_ES256;
  const algName =
    alg === COSE_ALG_ES256K ? "ES256K" : alg === COSE_ALG_ES256 ? "ES256" : "";

  // Import key based on algorithm (importSpkiPemVerifyKeyWithAlg auto-detects from DER if needed)
  const key = await importSpkiPemVerifyKeyWithAlg(publicKeyPem, algName);

  // Verify using curve-aware function
  return verifyCoseSign1WithParsedKey(coseSign1Bytes, key, verifyOpts);
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
