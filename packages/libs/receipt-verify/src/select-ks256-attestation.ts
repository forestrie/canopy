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
import {
  resolveDelegatedVerifyKey,
  type DelegatedResolution,
} from "./resolve-delegated-verify-key.js";
import type { RootVerifyKey } from "./root-verify-key.js";
import { extractKs256DelegationDigest } from "./verify-ks256-delegation.js";

/**
 * The attestation in `attestations` made for this certificate: the first
 * whose `digest` equals the certificate digest and whose `signatureHash`
 * equals keccak256 of the certificate signature.
 *
 * @param cert - From `extractKs256CertificateDigest` (delegation-cose) or
 *   {@link extractKs256DelegationDigest}.
 * @returns The first matching attestation, or `undefined` when none
 *   matches. The verifiers go further: they try EVERY match in order and
 *   keep the first that passes its own checks.
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
  return matchingIndexes(cert, attestations)[0];
}

/**
 * Resolve a COSE_Sign1's label-1000 certificate (a receipt or a checkpoint)
 * under `rootKeys`, trying the supplied attestations made for it.
 *
 * Every attestation whose digest and signature hash match the certificate
 * is tried in list order, and the first that resolves wins: a stale or
 * wrong-chain copy listed before a good one must not mask it. When none
 * resolves, the first failure is returned. When none matches at all, a
 * DIAGNOSTIC stand-in (one with the right digest if any, else the first) is
 * passed so a contract root fails with the precise
 * `ks256_attestation_*_mismatch` reason rather than a bare
 * `ks256_root_not_recovered`; a stand-in can never verify, because
 * `verifyKs256DelegationCert` checks digest and signature hash. With one
 * attestation supplied this is exactly the 3.1.0 behaviour of the singular
 * `ks256Attestation` input.
 *
 * @returns The resolution; `selected`, the index of the attestation it was
 *   resolved with (whether or not ecrecover made it unnecessary); and
 *   `rejected`, the matching attestations tried that failed their own
 *   checks (address, chain id, magic).
 * @internal
 */
export async function resolveWithKs256Attestations(
  coseSign1Bytes: Uint8Array,
  rootKeys: RootVerifyKey[],
  attestations: readonly Ks256Attestation[],
  forestChainId: bigint | undefined,
): Promise<{
  resolution: DelegatedResolution;
  selected?: number;
  rejected: number[];
}> {
  if (attestations.length === 0) {
    return {
      resolution: await resolveDelegatedVerifyKey(coseSign1Bytes, rootKeys),
      rejected: [],
    };
  }
  let cert: Ks256CertificateDigest | null = null;
  try {
    cert = extractKs256DelegationDigest(coseSign1Bytes);
  } catch {
    // Not a KS256 certificate (or not a COSE_Sign1): no attestation can be
    // made for it; the stand-in below is never consulted by an ES256 root.
    cert = null;
  }
  const candidates = cert === null ? [] : matchingIndexes(cert, attestations);
  const rejected: number[] = [];
  let firstFailure: DelegatedResolution | undefined;
  for (const i of candidates) {
    const resolution = await resolveDelegatedVerifyKey(
      coseSign1Bytes,
      rootKeys,
      { attestation: attestations[i], forestChainId },
    );
    if (resolution.kind !== "broken") {
      return { resolution, selected: i, rejected };
    }
    firstFailure ??= resolution;
    // Only an attestation's own checks make it "rejected"; any other
    // failure is the certificate's and no other copy can change it.
    if (!resolution.reason?.startsWith("ks256_attestation_")) break;
    rejected.push(i);
  }
  if (firstFailure !== undefined) return { resolution: firstFailure, rejected };
  const standIn =
    (cert !== null &&
      attestations.find((a) => bytesEqual(a.digest, cert.digest))) ||
    attestations[0];
  return {
    resolution: await resolveDelegatedVerifyKey(coseSign1Bytes, rootKeys, {
      attestation: standIn,
      forestChainId,
    }),
    rejected,
  };
}

function matchingIndexes(
  cert: Ks256CertificateDigest,
  attestations: readonly Ks256Attestation[],
): number[] {
  const signatureHash = keccak_256(cert.signature);
  const out: number[] = [];
  attestations.forEach((a, i) => {
    if (
      bytesEqual(a.digest, cert.digest) &&
      bytesEqual(a.signatureHash, signatureHash)
    ) {
      out.push(i);
    }
  });
  return out;
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let x = 0;
  for (let i = 0; i < a.length; i++) x |= a[i]! ^ b[i]!;
  return x === 0;
}
