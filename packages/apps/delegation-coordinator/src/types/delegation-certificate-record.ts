/**
 * Persisted delegation certificate row in {@link DelegationStoreDO}.
 *
 * Keyed by log id and {@link certificateKeyFor} composite; verified on PUT
 * before insert per arbor delegationcert rules.
 */

/** Stored BYOK delegation certificate for an MMR range and delegated key. */
export interface DelegationCertificateRecord {
  logIdHex32: string;
  certificateKey: string;
  certificate: Uint8Array;
  issuedAt: number;
  expiresAt: number;
}
