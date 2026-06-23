/** Stored delegation certificate keyed by certificateKey. */
export interface DelegationCertificateRecord {
  logIdHex32: string;
  certificateKey: string;
  certificate: Uint8Array;
  issuedAt: number;
  expiresAt: number;
}
