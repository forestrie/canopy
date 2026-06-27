/**
 * @deprecated Use {@link certificateKeyFor} from certificate-key.js.
 *
 * Legacy material-key naming retained for backward-compatible imports.
 */

/**
 * Build storage key for delegation material (deprecated name).
 *
 * @param mmrStart - MMR range start (inclusive).
 * @param mmrEnd - MMR range end (inclusive).
 * @param delegatedPublicKey - Delegated signer public key bytes.
 */
export async function materialKeyFor(
  mmrStart: number,
  mmrEnd: number,
  delegatedPublicKey: Uint8Array,
): Promise<string> {
  const hash = await sha256Hex(delegatedPublicKey);
  return `${mmrStart}:${mmrEnd}:${hash}`;
}

/**
 * SHA-256 hex digest of byte input.
 *
 * @param data - Bytes to hash.
 */
export async function sha256Hex(data: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
