/**
 * Offline KS256 root → delegation certificate check (plan-2610-03 D4, D5;
 * protocol ADR-0045 amendment 2026-10-18). Receipts are always ES256, signed
 * by a sealer's P-256 delegated key; what a KS256 root changes is how the
 * label-1000 delegation certificate is checked against it.
 *
 * - An EOA root verifies by ecrecover through `@forestrie/delegation-cose`'s
 *   `verifyDelegationCertificateKs256` with no hooks: pure, the same guarantee
 *   as an ES256 root. delegation-cose also enforces the KS256 alg binding.
 * - Anything ecrecover doesn't match (a contract root such as a Safe, or a
 *   wrong signer: offline you can't tell which) fails with
 *   `ks256_root_not_recovered`, unless the caller supplies an ERC-1271
 *   attestation (ks256-attestation.ts) bound to this root, this digest and
 *   the forest's genesis chain.
 *
 * No network and no injected callback: the chain read is a separate helper's
 * job (forestrie-cli, mcp-resolve), as for the known accumulator.
 */

import { coseUnprotectedToMap, decodeCoseSign1 } from "@forestrie/encoding";
import {
  extractKs256CertificateDigest,
  verifyDelegationCertificateKs256,
  type Ks256CertificateDigest,
} from "@forestrie/delegation-cose";
import {
  ERC1271_MAGIC_VALUE,
  type Ks256Attestation,
} from "./ks256-attestation.js";

/** Unprotected header label carrying the delegation certificate. */
const DELEGATION_CERT_LABEL = 1000;

/**
 * Chain evidence a caller may supply for a KS256 contract root. `forestChainId`
 * is read from the forest's genesis, never from the attestation or a
 * coordinator; an attestation without it is refused.
 */
export type Ks256DelegationEvidence = {
  attestation?: Ks256Attestation | undefined;
  forestChainId?: bigint | undefined;
};

/**
 * Check a delegation certificate against a KS256 root address.
 *
 * @param certBytes - The receipt's label-1000 COSE_Sign1 certificate.
 * @param rootAddress - 20-byte root from genesis or a caller-known log key.
 * @param evidence - Optional ERC-1271 attestation and the genesis chain id.
 * @returns `ok`, or a stable reason: `delegation_not_ks256` (wrong alg,
 *   WebAuthn envelope or malformed), `ks256_root_not_recovered`, or a
 *   `ks256_attestation_*` mismatch.
 */
export async function verifyKs256DelegationCert(
  certBytes: Uint8Array,
  rootAddress: Uint8Array,
  evidence: Ks256DelegationEvidence,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  let parts: Ks256CertificateDigest;
  try {
    parts = extractKs256CertificateDigest(certBytes);
  } catch {
    return { ok: false, reason: "delegation_not_ks256" };
  }
  if (await verifyDelegationCertificateKs256(certBytes, rootAddress)) {
    return { ok: true };
  }
  const { attestation, forestChainId } = evidence;
  if (!attestation) {
    return { ok: false, reason: "ks256_root_not_recovered" };
  }
  if (!bytesEqual(attestation.address, rootAddress)) {
    return { ok: false, reason: "ks256_attestation_address_mismatch" };
  }
  if (!bytesEqual(attestation.digest, parts.digest)) {
    return { ok: false, reason: "ks256_attestation_digest_mismatch" };
  }
  if (forestChainId === undefined) {
    return { ok: false, reason: "ks256_attestation_chain_unbound" };
  }
  if (attestation.chainId !== forestChainId) {
    return { ok: false, reason: "ks256_attestation_chain_mismatch" };
  }
  if (!bytesEqual(attestation.magic, ERC1271_MAGIC_VALUE)) {
    return { ok: false, reason: "ks256_attestation_magic_invalid" };
  }
  return { ok: true };
}

/**
 * Extract the KS256 delegation certificate's root address, digest and
 * signature from a receipt: what an ERC-1271 attestation helper calls
 * `isValidSignature` with. Does not verify anything.
 *
 * @param receiptCbor - COSE_Sign1 receipt bytes.
 * @returns `null` when the receipt carries no label-1000 certificate.
 * @throws When the certificate is not a KS256 certificate.
 */
export function extractKs256DelegationDigest(
  receiptCbor: Uint8Array,
): Ks256CertificateDigest | null {
  const decoded = decodeCoseSign1(receiptCbor);
  if (!decoded) throw new Error("receipt is not a COSE_Sign1");
  const certRaw = coseUnprotectedToMap(decoded.unprotected).get(
    DELEGATION_CERT_LABEL,
  );
  if (!(certRaw instanceof Uint8Array) || certRaw.length === 0) return null;
  return extractKs256CertificateDigest(certRaw);
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let x = 0;
  for (let i = 0; i < a.length; i++) x |= a[i]! ^ b[i]!;
  return x === 0;
}
