/**
 * KS256 delegation certificate decomposition: the alg binding arbor's sealer
 * enforces (`verify_certificate_ks256.go`) and the `(address, digest,
 * signature)` triple an ERC-1271 check or attestation is made over. Shared by
 * {@link verifyDelegationCertificateKs256} and offline receipt verification so
 * there is one TypeScript copy of the KS256 digest (plan-2610-03 D5, D6).
 */

import { decodeCborDeterministic } from "@forestrie/encoding";
import { keccak_256 } from "@noble/hashes/sha3";
import { bytesFromUnknown } from "./bytes-utils.js";
import type { Ks256CertificateDigest } from "./ks256-certificate-digest.js";
import { encodeSigStructure } from "./encode-sig-structure.js";
import { normalizeIntKeyedMap } from "./parse-delegated-cose-key.js";
import {
  COSE_ALG_ES256_WEBAUTHN,
  COSE_ALG_KS256,
  COSE_HEADER_ALG,
  COSE_HEADER_KID,
} from "./payload-labels.js";

/**
 * Extract the root address, digest and signature from a KS256 delegation
 * certificate, for an ERC-1271 `isValidSignature(digest, signature)` call or
 * to check an attestation of one. Does not verify the signature.
 *
 * @param certificate - CBOR COSE_Sign1 delegation certificate bytes.
 * @throws When the certificate is not KS256, carries a WebAuthn envelope, or
 *   its kid is not a 20-byte address.
 */
export function extractKs256CertificateDigest(
  certificate: Uint8Array,
): Ks256CertificateDigest {
  const decoded = decodeKs256Certificate(certificate);
  if (!decoded.ok) throw new Error(decoded.reason);
  const address = bytesFromUnknown(decoded.kid, "protected kid");
  if (address.length !== 20) {
    throw new Error("KS256 certificate kid must be a 20-byte address");
  }
  return { address, digest: decoded.digest, signature: decoded.signature };
}

/** Decoded KS256 certificate, or the reason it is not one. */
type Ks256Decoded =
  | {
      ok: true;
      kid: unknown;
      digest: Uint8Array;
      signature: Uint8Array;
    }
  | { ok: false; reason: string };

/**
 * Decode a delegation certificate as KS256: protected `alg` must be −65799 and
 * no WebAuthn envelope may ride in the unprotected header (alg confusion).
 *
 * @param certificate - CBOR COSE_Sign1 `[protected, unprotected, payload, signature]`.
 * @throws When the envelope is not a four-element COSE_Sign1 array.
 */
export function decodeKs256Certificate(certificate: Uint8Array): Ks256Decoded {
  const cert = decodeCborDeterministic(certificate) as unknown[];
  if (!Array.isArray(cert) || cert.length !== 4) {
    throw new Error("delegation certificate must be COSE_Sign1 array");
  }
  const protectedBytes = bytesFromUnknown(cert[0], "protected");
  const payloadBytes = bytesFromUnknown(cert[2], "payload");
  const signature = bytesFromUnknown(cert[3], "signature");

  const protectedMap = normalizeIntKeyedMap(
    decodeCborDeterministic(protectedBytes),
  );
  const alg = Number(protectedMap.get(COSE_HEADER_ALG));
  if (alg !== COSE_ALG_KS256) {
    return {
      ok: false,
      reason: `delegation cert alg ${String(protectedMap.get(COSE_HEADER_ALG))} is not KS256`,
    };
  }
  // KS256 defines no alg-specific material, so a WebAuthn envelope here is
  // confusion; arbor rejects it before any signature work.
  if (normalizeIntKeyedMap(cert[1]).has(COSE_ALG_ES256_WEBAUTHN)) {
    return {
      ok: false,
      reason: `unexpected WebAuthn envelope at unprotected label ${COSE_ALG_ES256_WEBAUTHN} on a KS256 certificate`,
    };
  }

  const digest = keccak_256(
    encodeSigStructure(protectedBytes, new Uint8Array(), payloadBytes),
  );
  return {
    ok: true,
    kid: protectedMap.get(COSE_HEADER_KID),
    digest,
    signature,
  };
}
