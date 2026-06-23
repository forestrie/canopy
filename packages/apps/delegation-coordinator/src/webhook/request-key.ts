import { sha256Hex } from "../certificate-key.js";

/**
 * Deterministic idempotency key for a pending delegation (matches pending
 * natural key components).
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
