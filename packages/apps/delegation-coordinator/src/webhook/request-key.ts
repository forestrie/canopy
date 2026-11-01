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
  mmrStart: bigint,
  mmrEnd: bigint,
  delegatedPubkeyHash: string,
): Promise<string> {
  // toString(10) matches the pre-FOR-613 number interpolation below 2^53, so
  // in-flight delivery rows keep their idempotency key.
  const canonical = `${logIdHex32}:${mmrStart.toString(10)}:${mmrEnd.toString(10)}:${delegatedPubkeyHash}`;
  return sha256Hex(new TextEncoder().encode(canonical));
}
