/**
 * Delegation certificate storage key:
 * `${mmrStart}:${mmrEnd}:${sha256hex(delegatedPublicKey)}`
 */
export async function certificateKeyFor(
  mmrStart: number,
  mmrEnd: number,
  delegatedPublicKey: Uint8Array,
): Promise<string> {
  const hash = await sha256Hex(delegatedPublicKey);
  return `${mmrStart}:${mmrEnd}:${hash}`;
}

/** @deprecated use certificateKeyFor */
export const materialKeyFor = certificateKeyFor;

export async function sha256Hex(data: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
