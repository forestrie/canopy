export const CBOR_CONTENT_TYPES = {
  CBOR: "application/cbor",
  COSE: "application/cose",
  COSE_SIGN1: 'application/cose; cose-type="cose-sign1"',
  SCITT_RECEIPT: "application/scitt-receipt+cbor",
  PROBLEM_CBOR: "application/problem+cbor",
} as const;
