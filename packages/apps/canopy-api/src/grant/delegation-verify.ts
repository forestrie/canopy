/**
 * Delegation certificate verification: extract delegated key from receipt and
 * verify the delegation chain.
 *
 * The sealer embeds a delegation certificate in unprotected header label 1000
 * of each receipt COSE Sign1. This certificate is itself a COSE Sign1 signed
 * by the custody key, with the delegated (ephemeral) public key in the payload.
 *
 * Verification flow:
 * 1. Extract delegation cert from receipt unprotected header 1000
 * 2. Verify delegation cert signature against custody key
 * 3. Extract delegated key from delegation cert payload label 5
 * 4. Use delegated key to verify receipt signature
 *
 * Note: Web Crypto does not support secp256k1, so we use @noble/curves for
 * secp256k1 signature verification.
 */

import { decode as decodeCbor, encode as encodeCbor } from "cbor-x";
import {
  coseUnprotectedToMap,
  decodeCoseSign1,
  type ParsedEcPublicKey,
  type ParsedVerifyKey,
  verifyCoseSign1,
  verifyCoseSign1WithParsedKey,
} from "@canopy/encoding";
import { secp256k1 } from "@noble/curves/secp256k1";

/** Unprotected header label for delegation certificate (sealer embeds via Custodian per-log delegation). */
export const DELEGATION_CERT_LABEL = 1000;

/** COSE_Key labels per RFC 9052. */
const COSE_KEY_KTY = 1;
const COSE_KEY_CRV = -1;
const COSE_KEY_X = -2;
const COSE_KEY_Y = -3;

/** COSE key type EC2. */
const COSE_KTY_EC2 = 2;

/** COSE curve identifiers. */
const COSE_CRV_P256 = 1;
const COSE_CRV_SECP256K1 = 8;

/** Delegation payload label for delegated key. */
const PAYLOAD_DELEGATED_KEY = 5;

export interface DelegationVerifyResult {
  /**
   * The extracted delegated public key as CryptoKey.
   * Note: For secp256k1, we return null here but provide parsedKey for direct verification.
   */
  delegatedKey: CryptoKey | null;
  /** Parsed EC key coordinates (for secp256k1 direct verification). */
  parsedKey: ParsedEcPublicKey;
  /** Whether the delegation cert signature was verified (if custody key provided). */
  signatureVerified: boolean;
}

/**
 * Extract the delegation certificate bytes from a receipt's unprotected header.
 * Returns null if no delegation cert is present.
 */
export function extractDelegationCertBytes(
  receiptUnprotected: unknown,
): Uint8Array | null {
  const umap = coseUnprotectedToMap(receiptUnprotected);
  const certRaw = umap.get(DELEGATION_CERT_LABEL);
  console.log("extractDelegationCertBytes", {
    rawType: Object.prototype.toString.call(receiptUnprotected),
    isMap: receiptUnprotected instanceof Map,
    mapKeys: umap.size > 0 ? Array.from(umap.keys()) : [],
    hasCertLabel: umap.has(DELEGATION_CERT_LABEL),
    certRawType: certRaw === undefined ? "undefined" : Object.prototype.toString.call(certRaw),
    certRawLen: certRaw instanceof Uint8Array ? certRaw.length : "N/A",
  });
  if (certRaw instanceof Uint8Array && certRaw.length > 0) {
    return certRaw;
  }
  return null;
}

/**
 * Parse a COSE_Key map (EC2) from CBOR-decoded payload structure.
 * Returns the x, y coordinates and curve name.
 */
function parseCoseKeyEC2(keyMap: unknown): {
  x: Uint8Array;
  y: Uint8Array;
  namedCurve: "P-256" | "secp256k1";
} | null {
  // Handle both Map and plain object forms
  let getValue: (label: number) => unknown;
  if (keyMap instanceof Map) {
    getValue = (label: number) => keyMap.get(label);
  } else if (typeof keyMap === "object" && keyMap !== null) {
    const obj = keyMap as Record<string | number, unknown>;
    getValue = (label: number) => obj[label] ?? obj[String(label)];
  } else {
    return null;
  }

  const kty = getValue(COSE_KEY_KTY);
  if (kty !== COSE_KTY_EC2 && kty !== BigInt(COSE_KTY_EC2)) return null;

  const crv = getValue(COSE_KEY_CRV);
  let namedCurve: "P-256" | "secp256k1";
  if (crv === COSE_CRV_P256 || crv === BigInt(COSE_CRV_P256)) {
    namedCurve = "P-256";
  } else if (crv === COSE_CRV_SECP256K1 || crv === BigInt(COSE_CRV_SECP256K1)) {
    namedCurve = "secp256k1";
  } else {
    return null;
  }

  const x = getValue(COSE_KEY_X);
  const y = getValue(COSE_KEY_Y);
  if (!(x instanceof Uint8Array) || x.length !== 32) return null;
  if (!(y instanceof Uint8Array) || y.length !== 32) return null;

  return { x, y, namedCurve };
}

/**
 * Import a COSE EC2 key as a Web Crypto CryptoKey for signature verification.
 * Only works for P-256; secp256k1 is not supported by Web Crypto.
 */
async function importCoseKeyEC2(keyMap: unknown): Promise<{
  cryptoKey: CryptoKey | null;
  parsed: ParsedEcPublicKey;
} | null> {
  const parsed = parseCoseKeyEC2(keyMap);
  if (!parsed) return null;

  const { x, y, namedCurve } = parsed;
  const parsedKey: ParsedEcPublicKey = { x, y, curve: namedCurve };

  // secp256k1 is not supported by Web Crypto - return null CryptoKey
  if (namedCurve === "secp256k1") {
    return { cryptoKey: null, parsed: parsedKey };
  }

  // Build uncompressed point: 0x04 || x || y
  const uncompressed = new Uint8Array(65);
  uncompressed[0] = 0x04;
  uncompressed.set(x, 1);
  uncompressed.set(y, 33);

  try {
    const cryptoKey = await crypto.subtle.importKey(
      "raw",
      uncompressed,
      { name: "ECDSA", namedCurve },
      true,
      ["verify"],
    );
    return { cryptoKey, parsed: parsedKey };
  } catch {
    return { cryptoKey: null, parsed: parsedKey };
  }
}

/**
 * Build COSE Sig_structure bytes for verification.
 * ["Signature1", protected_bstr, external_aad, payload]
 */
function buildSigStructure(
  protectedBstr: Uint8Array,
  payload: Uint8Array,
): Uint8Array {
  const sigStructure = [
    "Signature1",
    protectedBstr,
    new Uint8Array(0), // external_aad
    payload,
  ];
  return encodeCbor(sigStructure) as Uint8Array;
}

/**
 * Verify a COSE Sign1 signature using secp256k1 via @noble/curves.
 * This is needed because Web Crypto does not support secp256k1.
 */
async function verifySecp256k1Signature(
  sigStructure: Uint8Array,
  signature: Uint8Array,
  pubKey: ParsedEcPublicKey,
): Promise<boolean> {
  if (signature.length !== 64) return false;

  // Hash the Sig_structure (copy to ensure ArrayBuffer backing for strict types)
  const msgHash = await crypto.subtle.digest(
    "SHA-256",
    new Uint8Array(sigStructure),
  );
  const msgHashBytes = new Uint8Array(msgHash);

  // Build uncompressed public key: 04 || x || y
  const uncompressed = new Uint8Array(65);
  uncompressed[0] = 0x04;
  uncompressed.set(pubKey.x, 1);
  uncompressed.set(pubKey.y, 33);

  try {
    // noble-curves expects the signature as Signature object or hex
    return secp256k1.verify(signature, msgHashBytes, uncompressed);
  } catch {
    return false;
  }
}

/**
 * Extract the delegated public key from a delegation certificate payload.
 *
 * The delegation cert payload is a CBOR map with integer keys. Label 5 contains
 * the delegated key as a COSE_Key (EC2).
 */
export function extractDelegatedKeyFromPayload(
  payloadBytes: Uint8Array,
): unknown | null {
  if (payloadBytes.length === 0) return null;

  let payloadMap: unknown;
  try {
    payloadMap = decodeCbor(payloadBytes);
  } catch {
    return null;
  }

  let getValue: (label: number) => unknown;
  if (payloadMap instanceof Map) {
    getValue = (label: number) => payloadMap.get(label);
  } else if (typeof payloadMap === "object" && payloadMap !== null) {
    const obj = payloadMap as Record<string | number, unknown>;
    getValue = (label: number) => obj[label] ?? obj[String(label)];
  } else {
    return null;
  }

  return getValue(PAYLOAD_DELEGATED_KEY);
}

/**
 * Verify the delegation certificate and extract the delegated public key.
 *
 * @param delegationCertBytes - The delegation certificate COSE Sign1 bytes
 * @param custodyKey - Optional custody key to verify the delegation cert signature;
 *                     supports both CryptoKey (P-256) and ParsedEcPublicKey (secp256k1)
 * @returns The delegated key and verification status, or null if parsing fails
 */
export async function verifyDelegationCert(
  delegationCertBytes: Uint8Array,
  custodyKey?: ParsedVerifyKey,
): Promise<DelegationVerifyResult | null> {
  console.log("verifyDelegationCert: starting", {
    delegationCertBytesLen: delegationCertBytes.length,
    hasCustodyKey: !!custodyKey,
    custodyKeyType: custodyKey instanceof CryptoKey ? "CryptoKey" : "ParsedKey",
    custodyKeyCurve: custodyKey && !(custodyKey instanceof CryptoKey) ? (custodyKey as any).curve : "N/A",
  });

  // Decode the delegation cert
  const decoded = decodeCoseSign1(delegationCertBytes);
  if (!decoded) {
    console.warn("delegation-verify: failed to decode delegation cert");
    return null;
  }

  console.log("verifyDelegationCert: decoded cert", {
    protectedLen: decoded.protectedBstr.length,
    payloadLen: decoded.payloadBstr.length,
    signatureLen: decoded.signature.length,
  });

  // Verify signature if custody key provided
  let signatureVerified = false;
  if (custodyKey) {
    console.log("verifyDelegationCert: verifying signature against custody key");
    signatureVerified = await verifyCoseSign1WithParsedKey(
      delegationCertBytes,
      custodyKey,
      { logFailures: true, logPrefix: "delegation-cert" },
    );
    console.log("verifyDelegationCert: signature result", { signatureVerified });
    if (!signatureVerified) {
      console.warn("delegation-verify: delegation cert signature invalid");
      return null;
    }
  }

  // Extract delegated key from payload
  const delegatedKeyRaw = extractDelegatedKeyFromPayload(decoded.payloadBstr);
  if (!delegatedKeyRaw) {
    console.warn("delegation-verify: no delegated key in payload");
    return null;
  }

  // Import as CryptoKey (returns null for secp256k1)
  const importResult = await importCoseKeyEC2(delegatedKeyRaw);
  if (!importResult) {
    console.warn("delegation-verify: failed to parse delegated key");
    return null;
  }

  return {
    delegatedKey: importResult.cryptoKey,
    parsedKey: importResult.parsed,
    signatureVerified,
  };
}

/**
 * Result of delegation chain resolution.
 * Returns the candidate verify keys for the receipt signature.
 * The caller is responsible for attempting verification with each key
 * (supplying detachedPayload for peak receipts whose payload was cleared).
 */
export interface ResolveReceiptResult {
  /** Candidate keys in priority order (delegated key first, then custody key). */
  verifyKeys: ParsedVerifyKey[];
}

/**
 * Resolve the delegation chain from a receipt, returning candidate verify keys.
 *
 * If the receipt has a delegation cert (header 1000):
 * - Verify delegation cert against custody key
 * - Return [delegated key, custody key] (peak receipts may be signed by either)
 *
 * If no delegation cert:
 * - Return [custody key]
 *
 * Does NOT verify the receipt signature itself — the caller must do that with
 * the correct detachedPayload (the peak hash computed from the inclusion proof).
 */
export async function resolveReceiptVerifyKey(
  receiptCoseSign1Bytes: Uint8Array,
  custodyKey: ParsedVerifyKey,
): Promise<ResolveReceiptResult | null> {
  const decoded = decodeCoseSign1(receiptCoseSign1Bytes);
  if (!decoded) {
    console.warn("delegation-verify: failed to decode receipt");
    return null;
  }

  const delegationCertBytes = extractDelegationCertBytes(decoded.unprotected);
  if (!delegationCertBytes) {
    // No delegation — custody key is the only candidate.
    return { verifyKeys: [custodyKey] };
  }

  // Verify delegation cert signature against custody key.
  const result = await verifyDelegationCert(delegationCertBytes, custodyKey);
  if (!result) {
    return null;
  }

  // Return delegated key (preferred) then custody key as fallback.
  // Peak receipts may be signed by the custody key directly while the
  // delegation cert covers the checkpoint COSE Sign1.
  const candidates: ParsedVerifyKey[] = [];
  if (result.delegatedKey) {
    candidates.push(result.delegatedKey);
  } else {
    candidates.push(result.parsedKey);
  }
  candidates.push(custodyKey);
  return { verifyKeys: candidates };
}
