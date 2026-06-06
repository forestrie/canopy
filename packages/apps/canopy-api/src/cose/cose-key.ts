/**
 * IANA COSE_Key parameters (RFC 9052 / IANA COSE registry).
 * Shared by forest genesis, receipt verification, and future COSE consumers.
 */

export const COSE_KEY_KTY = 1;
export const COSE_KEY_ALG = 3;
export const COSE_EC2_CRV = -1;
export const COSE_EC2_X = -2;
export const COSE_EC2_Y = -3;

export const COSE_KTY_EC2 = 2;
export const COSE_CRV_P256 = 1;
export const COSE_ALG_ES256 = -7;
/** KS256: secp256k1 + Keccak-256 + Ethereum address (COSE private use). */
export const COSE_ALG_KS256 = -65799;
