/**
 * Content-Type values used across CBOR-first HTTP APIs (SCRAPI, COSE, receipts).
 */

export const CBOR_CONTENT_TYPES = {
  CBOR: "application/cbor",
  COSE: "application/cose",
  COSE_SIGN1: 'application/cose; cose-type="cose-sign1"',
  /**
   * SCITT Receipt media type registered by draft-ietf-scitt-scrapi-05 §6.3
   * ("This section requests registration of the 'application/
   * scitt.receipt+cose' media type"). Resolve-receipt's success
   * `Content-Type` for every request (FOR-559); see {@link resolveReceipt}
   * in `../scrapi/resolve-receipt.js`.
   */
  SCITT_RECEIPT_COSE: "application/scitt.receipt+cose",
  PROBLEM_CBOR: "application/problem+cbor",
} as const;
