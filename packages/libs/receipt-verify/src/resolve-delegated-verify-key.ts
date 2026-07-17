/**
 * Offline delegation-chain resolution (FOR-297). When a checkpoint/receipt was
 * signed by a DELEGATED key rather than the log's root key, the delegation
 * certificate travels in the receipt's unprotected header at label 1000
 * (sealer-embedded). This module verifies that certificate under the genesis
 * trust root and returns the delegated public key as an additional verify
 * candidate — the offline port of canopy-api's `resolveReceiptVerifyKey`.
 *
 * ES256 (P-256) only: the offline verifier is ES256-only (genesis alg), and
 * sealer delegate keys are always secp256r1. KS256-rooted delegation is a
 * server-only concern.
 *
 * Trust anchors (FOR-297 trust ladder): `rootKeys` need not be genesis-derived
 * — a caller-known log OWNER key works identically (see
 * `verifyReceiptOfflineWithKeys`), because the certificate issuer for a child
 * log IS its owner. What differs is why you trust the keys: genesis-derived
 * keys prove the key↔log binding from the bootstrap; a caller-known key merely
 * asserts it (provenance of the key is the only defence, and there is no grant
 * lifecycle visibility or split-view protection). The grant-chain walk
 * (approach A, open) will derive per-log owner keys from genesis + public
 * tiles, closing that gap without key distribution.
 *
 * Note (parity with the server port source): this establishes that the root
 * authorized the delegated key, but does NOT yet enforce the certificate's MMR
 * window or expiry-at-issuance against the leaf — that hardening is shared with
 * the server path and tracked separately (FOR-323).
 */

import {
  coseUnprotectedToMap,
  decodeCborDeterministic,
  decodeCoseSign1,
  verifyCoseSign1WithParsedKey,
} from "@forestrie/encoding";

/** Unprotected header label carrying the delegation certificate. */
const DELEGATION_CERT_LABEL = 1000;

/** COSE_Key labels (RFC 9052) and EC2/P-256 constants. */
const COSE_KEY_KTY = 1;
const COSE_KEY_CRV = -1;
const COSE_KEY_X = -2;
const COSE_KEY_Y = -3;
const COSE_KTY_EC2 = 2;
const COSE_CRV_P256 = 1;

/** Delegation-cert payload label for the delegated COSE_Key. */
const PAYLOAD_DELEGATED_KEY = 5;

/**
 * root-only: no delegation cert present — verify against the root keys as-is.
 * resolved: cert verified under a root key; use `delegatedKey` first.
 * broken: a cert is present but did not verify under the root, or its delegated
 *   key could not be parsed — the delegation chain is invalid.
 */
export type DelegatedResolution =
  | { kind: "root-only" }
  | { kind: "resolved"; delegatedKey: CryptoKey }
  | { kind: "broken" };

function extractDelegationCertBytes(unprotected: unknown): Uint8Array | null {
  const umap = coseUnprotectedToMap(unprotected);
  const certRaw = umap.get(DELEGATION_CERT_LABEL);
  return certRaw instanceof Uint8Array && certRaw.length > 0 ? certRaw : null;
}

function labelGetter(map: unknown): ((label: number) => unknown) | null {
  if (map instanceof Map) return (label) => map.get(label);
  if (typeof map === "object" && map !== null) {
    const obj = map as Record<string | number, unknown>;
    return (label) => obj[label] ?? obj[String(label)];
  }
  return null;
}

function parseCoseKeyEC2(
  keyMap: unknown,
): { x: Uint8Array; y: Uint8Array } | null {
  const get = labelGetter(keyMap);
  if (!get) return null;

  const kty = get(COSE_KEY_KTY);
  if (kty !== COSE_KTY_EC2 && kty !== BigInt(COSE_KTY_EC2)) return null;
  const crv = get(COSE_KEY_CRV);
  if (crv !== COSE_CRV_P256 && crv !== BigInt(COSE_CRV_P256)) return null;

  const x = get(COSE_KEY_X);
  const y = get(COSE_KEY_Y);
  if (!(x instanceof Uint8Array) || x.length !== 32) return null;
  if (!(y instanceof Uint8Array) || y.length !== 32) return null;
  return { x, y };
}

async function importDelegatedKey(keyMap: unknown): Promise<CryptoKey | null> {
  const parsed = parseCoseKeyEC2(keyMap);
  if (!parsed) return null;
  const uncompressed = new Uint8Array(65);
  uncompressed[0] = 0x04;
  uncompressed.set(parsed.x, 1);
  uncompressed.set(parsed.y, 33);
  try {
    return await crypto.subtle.importKey(
      "raw",
      uncompressed,
      { name: "ECDSA", namedCurve: "P-256" },
      true,
      ["verify"],
    );
  } catch {
    return null;
  }
}

function extractDelegatedKeyFromPayload(
  payloadBytes: Uint8Array,
): unknown | null {
  if (!payloadBytes || payloadBytes.length === 0) return null;
  let payloadMap: unknown;
  try {
    payloadMap = decodeCborDeterministic(payloadBytes);
  } catch {
    return null;
  }
  const get = labelGetter(payloadMap);
  return get ? get(PAYLOAD_DELEGATED_KEY) : null;
}

/**
 * Resolve the delegated verify key from a receipt's delegation certificate.
 *
 * @param receiptCbor - the COSE_Sign1 receipt bytes.
 * @param rootKeys - genesis-derived ES256 root verify keys.
 */
export async function resolveDelegatedVerifyKey(
  receiptCbor: Uint8Array,
  rootKeys: CryptoKey[],
): Promise<DelegatedResolution> {
  const decoded = decodeCoseSign1(receiptCbor);
  if (!decoded) return { kind: "root-only" };

  const certBytes = extractDelegationCertBytes(decoded.unprotected);
  if (!certBytes) return { kind: "root-only" };

  let verified = false;
  for (const rootKey of rootKeys) {
    if (
      await verifyCoseSign1WithParsedKey(certBytes, rootKey, {
        logPrefix: "delegation-cert-offline",
      })
    ) {
      verified = true;
      break;
    }
  }
  if (!verified) return { kind: "broken" };

  const certDecoded = decodeCoseSign1(certBytes);
  if (!certDecoded) return { kind: "broken" };

  const keyRaw = extractDelegatedKeyFromPayload(certDecoded.payloadBstr);
  const delegatedKey = keyRaw ? await importDelegatedKey(keyRaw) : null;
  if (!delegatedKey) return { kind: "broken" };

  return { kind: "resolved", delegatedKey };
}
