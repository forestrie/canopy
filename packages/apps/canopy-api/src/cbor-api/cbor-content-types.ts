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
   * `Content-Type` (FOR-559); see {@link resolveReceipt} in
   * `../scrapi/resolve-receipt.js` for the one-release `Accept` alias to
   * {@link SCITT_RECEIPT}.
   */
  SCITT_RECEIPT_COSE: "application/scitt.receipt+cose",
  /**
   * Pre-draft receipt media type. Kept for one release as an `Accept`-
   * negotiated alias of {@link SCITT_RECEIPT_COSE} (FOR-559, plan-2609-07
   * decision L4) so existing clients requesting it by name do not break;
   * new clients should send `Accept: application/scitt.receipt+cose`.
   */
  SCITT_RECEIPT: "application/scitt-receipt+cbor",
  PROBLEM_CBOR: "application/problem+cbor",
} as const;
