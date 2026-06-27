/**
 * @deprecated Use {@link DelegationCertificateRecord} from delegation-certificate-record.
 */

/** @deprecated use DelegationCertificateRecord */
export interface MaterialRecord {
  logIdHex32: string;
  materialKey: string;
  certificate: Uint8Array;
  issuedAt: number;
  expiresAt: number;
}
