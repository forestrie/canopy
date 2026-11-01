/**
 * Delegation certificate storage key derivation and hashing helpers.
 *
 * Composite key `${mmrStart}:${mmrEnd}:${sha256(delegatedPublicKey)}` indexes
 * rows in {@link DelegationStoreDO} and matches pending natural keys.
 */

/**
 * Build storage key for a delegation certificate row.
 *
 * @param mmrStart - MMR range start (inclusive).
 * @param mmrEnd - MMR range end (inclusive).
 * @param delegatedPublicKey - Delegated signer public key bytes.
 * @returns Composite certificateKey string.
 */
export async function certificateKeyFor(
  mmrStart: bigint,
  mmrEnd: bigint,
  delegatedPublicKey: Uint8Array,
): Promise<string> {
  const hash = await sha256Hex(delegatedPublicKey);
  // toString(10) of a bigint is byte-identical to the earlier number
  // interpolation below 2^53, so stored keys keep matching.
  return `${mmrStart.toString(10)}:${mmrEnd.toString(10)}:${hash}`;
}

/** @deprecated use certificateKeyFor */
export const materialKeyFor = certificateKeyFor;

/**
 * SHA-256 hex digest of byte input.
 *
 * @param data - Bytes to hash.
 * @returns Lowercase hex digest string.
 */
export async function sha256Hex(data: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
