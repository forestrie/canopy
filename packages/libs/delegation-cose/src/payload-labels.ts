/**
 * Integer label constants for Forestrie delegation COSE headers and payload.
 * Values must match arbor
 * [delegationcert constants](https://github.com/forestrie/arbor/tree/main/services/pkgs/delegationcert)
 * — changing a label breaks sealer and coordinator interop.
 */

/** COSE protected header label for signing algorithm (RFC 9052). */
export const COSE_HEADER_ALG = 1;
/** COSE protected header label for content type. */
export const COSE_HEADER_CTY = 3;
/** COSE protected header label for key identifier (kid). */
export const COSE_HEADER_KID = 4;

/** Delegation payload label: Forestrie log id (32-char hex string). */
export const PAYLOAD_LOG_ID = 1;
/** Delegation payload label: inclusive MMR start index. */
export const PAYLOAD_MMR_START = 3;
/** Delegation payload label: exclusive MMR end index. */
export const PAYLOAD_MMR_END = 4;
/** Delegation payload label: inline EC2 P-256 COSE_Key map. */
export const PAYLOAD_DELEGATED_KEY = 5;
/** Delegation payload label: opaque constraints map. */
export const PAYLOAD_CONSTRAINTS = 6;
/** Delegation payload label: schema version integer. */
export const PAYLOAD_SCHEMA_VER = 7;
/** Delegation payload label: issued-at Unix seconds. */
export const PAYLOAD_ISSUED_AT = 8;
/** Delegation payload label: expires-at Unix seconds. */
export const PAYLOAD_EXPIRES_AT = 9;
/** Delegation payload label: 16-byte delegation correlation id. */
export const PAYLOAD_DELEGATION_ID = 10;

/** COSE_Key label: key type (RFC 9052). */
export const COSE_KTY = 1;
/** COSE_Key label: curve identifier. */
export const COSE_CRV = -1;
/** COSE_Key label: EC x coordinate. */
export const COSE_X = -2;
/** COSE_Key label: EC y coordinate. */
export const COSE_Y = -3;
/** COSE_Key kty value for elliptic curve keys. */
export const COSE_KTY_EC2 = 2;
/** COSE_Key crv value for NIST P-256. */
export const COSE_CRV_P256 = 1;

/** COSE alg ES256 (-7): SHA-256 over Sig_structure, P-256 signature. */
export const COSE_ALG_ES256 = -7;
/** COSE alg KS256 (-65799): keccak256 over Sig_structure, secp256k1 signature. */
export const COSE_ALG_KS256 = -65799;

/** KS256 EOA signature size: 32-byte r + 32-byte s + 1-byte recovery id. */
export const KS256_EOA_SIG_BYTES = 65;
/** ES256 signature size: IEEE P1363 32-byte r + 32-byte s. */
export const ES256_SIG_BYTES = 64;
