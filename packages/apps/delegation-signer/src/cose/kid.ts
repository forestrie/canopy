export async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  const buf = await crypto.subtle.digest("SHA-256", bytes);
  return new Uint8Array(buf);
}

/**
 * Derive a 16-byte kid from a public key's DER bytes.
 *
 * Profile: kid = SHA-256(pubkey_bytes)[0..16]
 */
export async function deriveKidFromPublicKeyDer(
  publicKeyDer: Uint8Array,
): Promise<Uint8Array> {
  const digest = await sha256(publicKeyDer);
  return digest.slice(0, 16);
}
