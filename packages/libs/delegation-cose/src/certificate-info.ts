/** Parsed delegation certificate payload fields. */
export interface CertificateInfo {
  logIdHex32: string;
  mmrStart: number;
  mmrEnd: number;
  issuedAt: number;
  expiresAt: number;
  schemaVersion: number;
  delegationId: Uint8Array;
}
