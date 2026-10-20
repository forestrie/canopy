/**
 * Choosing an ERC-1271 attestation from several (owner ruling D8,
 * 2026-10-19). A contract KS256 root (a Safe) that rotated its delegate
 * signs one certificate per delegate, and each certificate needs its own
 * attestation; a caller holding a checkpoint chain or several receipts
 * supplies them as a list. Each certificate takes the attestation whose
 * `digest` AND `signatureHash` are that certificate's: keccak256 of its
 * Sig_structure and keccak256 of its signature bytes.
 *
 * Selection never makes an attestation acceptable on its own:
 * `verifyKs256DelegationCert` still checks address, digest, signature hash,
 * genesis chain id and magic.
 */

import { keccak_256 } from "@noble/hashes/sha3";
import type { Ks256CertificateDigest } from "@forestrie/delegation-cose";
import type { Ks256Attestation } from "./ks256-attestation.js";
import { extractKs256DelegationDigest } from "./verify-ks256-delegation.js";

/**
 * The attestation in `attestations` made for this certificate: the first
 * whose `digest` equals the certificate digest and whose `signatureHash`
 * equals keccak256 of the certificate signature.
 *
 * @param cert - From `extractKs256CertificateDigest` (delegation-cose) or
 *   {@link extractKs256DelegationDigest}.
 * @returns The matching attestation, or `undefined` when none matches.
 */
export function selectKs256Attestation(
  cert: Ks256CertificateDigest,
  attestations: readonly Ks256Attestation[],
): Ks256Attestation | undefined {
  const i = selectKs256AttestationIndex(cert, attestations);
  return i === undefined ? undefined : attestations[i];
}

function selectKs256AttestationIndex(
  cert: Ks256CertificateDigest,
  attestations: readonly Ks256Attestation[],
): number | undefined {
  const signatureHash = keccak_256(cert.signature);
  for (let i = 0; i < attestations.length; i++) {
    const a = attestations[i]!;
    if (
      bytesEqual(a.digest, cert.digest) &&
      bytesEqual(a.signatureHash, signatureHash)
    ) {
      return i;
    }
  }
  return undefined;
}

/**
 * The attestation to hand `resolveDelegatedVerifyKey` for one COSE_Sign1
 * (a receipt or a checkpoint) carrying a label-1000 certificate.
 *
 * - `selected`: index of the attestation made for this certificate, if any.
 * - `evidence`: the selected attestation; when none matches, a DIAGNOSTIC
 *   stand-in (one with the right digest if any, else the first) so a
 *   contract root fails with the precise `ks256_attestation_*_mismatch`
 *   reason rather than a bare `ks256_root_not_recovered`. A stand-in can
 *   never verify: its digest or signature hash differs from the
 *   certificate's, and `verifyKs256DelegationCert` checks both. With one
 *   attestation supplied this is exactly the 3.1.0 behaviour of the
 *   singular `ks256Attestation` input.
 *
 * @internal
 */
export function attestationForCoseSign1(
  coseSign1Bytes: Uint8Array,
  attestations: readonly Ks256Attestation[],
): { selected?: number; evidence?: Ks256Attestation } {
  if (attestations.length === 0) return {};
  let cert: Ks256CertificateDigest | null = null;
  try {
    cert = extractKs256DelegationDigest(coseSign1Bytes);
  } catch {
    // Not a KS256 certificate (or not a COSE_Sign1): no attestation can be
    // made for it; the stand-in below is never consulted by an ES256 root.
    cert = null;
  }
  if (cert !== null) {
    const selected = selectKs256AttestationIndex(cert, attestations);
    if (selected !== undefined) {
      return { selected, evidence: attestations[selected] };
    }
    const sameDigest = attestations.find((a) =>
      bytesEqual(a.digest, cert.digest),
    );
    if (sameDigest !== undefined) return { evidence: sameDigest };
  }
  return { evidence: attestations[0] };
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let x = 0;
  for (let i = 0; i < a.length; i++) x |= a[i]! ^ b[i]!;
  return x === 0;
}
