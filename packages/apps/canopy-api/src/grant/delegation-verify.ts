/**
 * Delegation certificate verification: extract delegated key from receipt and
 * verify the delegation chain.
 *
 * ES256 (P-256) delegated keys use Web Crypto. KS256 root signature verification
 * on delegation certs uses verifyKs256DelegationCert (keccak + ecrecover/ERC-1271).
 */

import { decodeCborDeterministic } from "@forestrie/encoding";
import {
  COSE_ALG_ES256,
  coseUnprotectedToMap,
  decodeCoseSign1,
  type ParsedEcPublicKey,
  verifyCoseSign1WithParsedKey,
} from "@forestrie/encoding";
import { isParsedKs256RootKey } from "./parsed-ks256-root-key.js";
import { verifyKs256DelegationCert } from "./ks256-verify.js";
import type { RootVerifyKey } from "../env/trust-root-client.js";
import type { DelegationVerifyResult } from "./delegation-verify-result.js";
import type { ResolveReceiptResult } from "./resolve-receipt-result.js";

export type { DelegationVerifyResult, ResolveReceiptResult } from "./types.js";

/** Unprotected header label for delegation certificate (sealer embeds via Custodian per-log delegation). */
export const DELEGATION_CERT_LABEL = 1000;

/** COSE_Key labels per RFC 9052. */
const COSE_KEY_KTY = 1;
const COSE_KEY_CRV = -1;
const COSE_KEY_X = -2;
const COSE_KEY_Y = -3;

/** COSE key type EC2. */
const COSE_KTY_EC2 = 2;

/** COSE curve P-256 (secp256r1). */
const COSE_CRV_P256 = 1;

/** Delegation payload label for delegated key. */
const PAYLOAD_DELEGATED_KEY = 5;

/**
 * Extract the delegation certificate bytes from a receipt's unprotected header.
 */
export function extractDelegationCertBytes(
  receiptUnprotected: unknown,
): Uint8Array | null {
  const umap = coseUnprotectedToMap(receiptUnprotected);
  const certRaw = umap.get(DELEGATION_CERT_LABEL);
  if (certRaw instanceof Uint8Array && certRaw.length > 0) {
    return certRaw;
  }
  return null;
}

function parseCoseKeyEC2(keyMap: unknown): {
  x: Uint8Array;
  y: Uint8Array;
} | null {
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
  if (crv !== COSE_CRV_P256 && crv !== BigInt(COSE_CRV_P256)) return null;

  const x = getValue(COSE_KEY_X);
  const y = getValue(COSE_KEY_Y);
  if (!(x instanceof Uint8Array) || x.length !== 32) return null;
  if (!(y instanceof Uint8Array) || y.length !== 32) return null;

  return { x, y };
}

async function importCoseKeyEC2(keyMap: unknown): Promise<{
  cryptoKey: CryptoKey;
  parsed: ParsedEcPublicKey;
} | null> {
  const parsed = parseCoseKeyEC2(keyMap);
  if (!parsed) return null;

  const { x, y } = parsed;
  const parsedKey: ParsedEcPublicKey = { x, y, curve: "P-256" };

  const uncompressed = new Uint8Array(65);
  uncompressed[0] = 0x04;
  uncompressed.set(x, 1);
  uncompressed.set(y, 33);

  try {
    const cryptoKey = await crypto.subtle.importKey(
      "raw",
      uncompressed,
      { name: "ECDSA", namedCurve: "P-256" },
      true,
      ["verify"],
    );
    return { cryptoKey, parsed: parsedKey };
  } catch {
    return null;
  }
}

export function extractDelegatedKeyFromPayload(
  payloadBytes: Uint8Array,
): unknown | null {
  if (payloadBytes.length === 0) return null;

  let payloadMap: unknown;
  try {
    payloadMap = decodeCborDeterministic(payloadBytes);
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
 */
export async function verifyDelegationCert(
  delegationCertBytes: Uint8Array,
  custodyKey?: RootVerifyKey,
  opts?: { rpcUrls?: string[] },
): Promise<DelegationVerifyResult | null> {
  const decoded = decodeCoseSign1(delegationCertBytes);
  if (!decoded) {
    console.warn("delegation-verify: failed to decode delegation cert");
    return null;
  }

  let signatureVerified = false;
  if (custodyKey) {
    if (isParsedKs256RootKey(custodyKey)) {
      signatureVerified = await verifyKs256DelegationCert(
        delegationCertBytes,
        custodyKey,
        { rpcUrls: opts?.rpcUrls, logFailures: true },
      );
    } else {
      signatureVerified = await verifyCoseSign1WithParsedKey(
        delegationCertBytes,
        custodyKey,
        { logFailures: true, logPrefix: "delegation-cert" },
      );
    }
    if (!signatureVerified) {
      console.warn("delegation-verify: delegation cert signature invalid");
      return null;
    }
  }

  const delegatedKeyRaw = extractDelegatedKeyFromPayload(decoded.payloadBstr);
  if (!delegatedKeyRaw) {
    console.warn("delegation-verify: no delegated key in payload");
    return null;
  }

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
 * Resolve the delegation chain from a receipt, returning candidate verify keys.
 */
export async function resolveReceiptVerifyKey(
  receiptCoseSign1Bytes: Uint8Array,
  custodyKey: RootVerifyKey,
  opts?: { rpcUrls?: string[] },
): Promise<ResolveReceiptResult | null> {
  const decoded = decodeCoseSign1(receiptCoseSign1Bytes);
  if (!decoded) {
    console.warn("delegation-verify: failed to decode receipt");
    return null;
  }

  const delegationCertBytes = extractDelegationCertBytes(decoded.unprotected);
  if (!delegationCertBytes) {
    return { verifyKeys: [custodyKey] };
  }

  const result = await verifyDelegationCert(
    delegationCertBytes,
    custodyKey,
    opts,
  );
  if (!result) {
    return null;
  }

  const candidates: RootVerifyKey[] = [];
  if (result.delegatedKey) {
    candidates.push(result.delegatedKey);
  } else {
    candidates.push(result.parsedKey);
  }
  candidates.push(custodyKey);
  return { verifyKeys: candidates };
}

/** Re-export for KS256 delegation verify modules. */
export { COSE_ALG_ES256 };
