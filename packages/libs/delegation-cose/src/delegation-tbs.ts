/**
 * Pre-signature delegation certificate material. External signers (KMS,
 * mandate agent, `eth_sign`) digest `sigStructureBytes` only — assembly via
 * {@link assembleDelegationCertificate} happens after signing.
 */

/** Protected + payload bytes and Sig_structure for external signing. */
export interface DelegationToBeSigned {
  /** CBOR bstr of the COSE protected header map. */
  protectedBytes: Uint8Array;
  /** CBOR bstr of the integer-key delegation payload map. */
  payloadBytes: Uint8Array;
  /** RFC 8152 Sig_structure bytes passed to the root signing operation. */
  sigStructureBytes: Uint8Array;
}
