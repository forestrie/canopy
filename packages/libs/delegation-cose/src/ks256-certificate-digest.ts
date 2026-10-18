/**
 * The `(address, digest, signature)` triple a KS256 root signs in a delegation
 * certificate. An ERC-1271 `isValidSignature` call, or an attestation of one,
 * is made over exactly these bytes (plan-2610-03 D4).
 */

/** What a KS256 root signs over in a delegation certificate. */
export interface Ks256CertificateDigest {
  /** 20-byte root address from protected header kid (label 4). */
  address: Uint8Array;
  /** keccak256(Sig_structure), as arbor's sealer and univocity compute it. */
  digest: Uint8Array;
  /** Signature bytes: 65-byte `r‖s‖v` for an EOA, any length for ERC-1271. */
  signature: Uint8Array;
}
