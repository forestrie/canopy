/** COSE protected header labels. */
export const COSE_HEADER_ALG = 1;
export const COSE_HEADER_CTY = 3;
export const COSE_HEADER_KID = 4;

/** Delegation payload labels per forestrie.delegation profile. */
export const PAYLOAD_LOG_ID = 1;
export const PAYLOAD_MMR_START = 3;
export const PAYLOAD_MMR_END = 4;
export const PAYLOAD_DELEGATED_KEY = 5;
export const PAYLOAD_CONSTRAINTS = 6;
export const PAYLOAD_SCHEMA_VER = 7;
export const PAYLOAD_ISSUED_AT = 8;
export const PAYLOAD_EXPIRES_AT = 9;
export const PAYLOAD_DELEGATION_ID = 10;

/** COSE_Key labels (RFC 9052). */
export const COSE_KTY = 1;
export const COSE_CRV = -1;
export const COSE_X = -2;
export const COSE_Y = -3;
export const COSE_KTY_EC2 = 2;
export const COSE_CRV_P256 = 1;

export const COSE_ALG_ES256 = -7;
export const COSE_ALG_KS256 = -65799;

export const KS256_EOA_SIG_BYTES = 65;
export const ES256_SIG_BYTES = 64;
