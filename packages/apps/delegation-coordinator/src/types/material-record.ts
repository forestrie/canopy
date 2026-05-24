/** Stored delegation certificate material keyed by materialKey. */
export interface MaterialRecord {
  logIdHex32: string;
  materialKey: string;
  certificate: Uint8Array;
  issuedAt: number;
  expiresAt: number;
}
