/**
 * Deterministic idempotency keys for pending delegation webhooks.
 *
 * Matches the natural key on pending rows in {@link DelegationStoreDO}
 * (log id, MMR range, delegated key hash).
 */

import { sha256Hex } from "../certificate-key.js";

/**
 * Deterministic idempotency key for a pending delegation.
 *
 * @param logIdHex32 - Target log id.
 * @param mmrStart - MMR range start (inclusive).
 * @param mmrEnd - MMR range end (inclusive).
 * @param delegatedPubkeyHash - SHA-256 hex of delegated public key bytes.
 * @returns Hex digest used as webhook `requestKey` and delivery primary key.
 */
export async function requestKeyFor(
  logIdHex32: string,
  mmrStart: number,
  mmrEnd: number,
  delegatedPubkeyHash: string,
): Promise<string> {
  const canonical = `${logIdHex32}:${mmrStart}:${mmrEnd}:${delegatedPubkeyHash}`;
  return sha256Hex(new TextEncoder().encode(canonical));
}
