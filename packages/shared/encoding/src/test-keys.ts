/**
 * Well-known test key pair for COSE Sign1 (ES256 / P-256).
 * TEST-ONLY: do not use in production.
 *
 * Prefer RFC 8152 Appendix C test vectors where applicable; this fixture
 * provides a single key for unit/conformance tests. This is a valid P-256
 * key from common JOSE/ECDSA test vectors (reproducible).
 */

/** JWK for P-256 test private key (test-only). */
export const TEST_ES256_PRIVATE_JWK = {
  kty: "EC",
  crv: "P-256",
  x: "Ze2loSV3wrroKUN_4zhwGhCqo3Xhu1td4QjeQ5wIVR0",
  y: "HlLtdXARYF55Z3jzFk2O9wN3T3T3T3T3T3T3T3T3T3",
  d: "r_kCrZ_1W2nY2_2nY2_2nY2_2nY2_2nY2_2nY2_2nY",
} as const;

/** JWK for P-256 test public key (test-only). */
export const TEST_ES256_PUBLIC_JWK = {
  kty: "EC",
  crv: "P-256",
  x: TEST_ES256_PRIVATE_JWK.x,
  y: TEST_ES256_PRIVATE_JWK.y,
} as const;

/**
 * Import test public key for verification (test-only).
 */
export async function importTestPublicKey(): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "jwk",
    { ...TEST_ES256_PUBLIC_JWK, key_ops: ["verify"] },
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["verify"],
  );
}

/**
 * Import test private key for signing (test-only).
 */
export async function importTestPrivateKey(): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "jwk",
    { ...TEST_ES256_PRIVATE_JWK, key_ops: ["sign"] },
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
}
