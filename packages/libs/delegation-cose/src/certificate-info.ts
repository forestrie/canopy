/**
 * Parsed delegation certificate payload metadata. Populated by
 * {@link parseDelegationCertificate} after COSE envelope decode; used by
 * delegation-coordinator for lease persistence and deduplication.
 */

/** Parsed delegation certificate payload fields (labels 1, 3–4, 7–10). */
export interface CertificateInfo {
  /** 32-character hex Forestrie log id. */
  logIdHex32: string;
  /** Inclusive MMR leaf index start. */
  mmrStart: number;
  /** Exclusive MMR leaf index end. */
  mmrEnd: number;
  /** Unix seconds when the delegation becomes valid. */
  issuedAt: number;
  /** Unix seconds when the delegation expires. */
  expiresAt: number;
  /** Payload schema version (currently 1). */
  schemaVersion: number;
  /** 16-byte delegation correlation id. */
  delegationId: Uint8Array;
}
