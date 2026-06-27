/**
 * Forestrie delegation COSE Sign1 content type (protected header label 3).
 * Distinguishes delegation certificates from statement or grant COSE uses in
 * canopy-api — see
 * [arc statement COSE encoding](https://github.com/forestrie/canopy/blob/main/docs/arc/arc-statement-cose-encoding.md).
 */

/** Protected header cty value for Forestrie delegation certificates. */
export const DELEGATION_CONTENT_TYPE = "application/forestrie.delegation+cbor";
