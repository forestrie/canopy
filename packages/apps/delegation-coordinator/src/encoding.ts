/**
 * Base64 and base64url codecs for coordinator HTTP/JSON and session tokens.
 *
 * Upstream: handler bodies, wallet-challenge envelopes, webhook payloads.
 * Downstream: {@link DelegationStoreDO} persistence and HMAC session minting.
 */

/** Decode standard base64 (RFC 4648) to bytes. */
export function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}

/**
 * Encode bytes as standard base64 (RFC 4648).
 *
 * @param value - Raw bytes to encode.
 * @returns Base64 string without line breaks.
 */
export function bytesToBase64(value: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < value.length; i++) {
    binary += String.fromCharCode(value[i]!);
  }
  return btoa(binary);
}

/**
 * Encode bytes as URL-safe base64 without padding.
 *
 * @param value - Raw bytes to encode.
 * @returns Base64url string suitable for JWT-like tokens.
 */
export function bytesToBase64Url(value: Uint8Array): string {
  return bytesToBase64(value)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

/**
 * Decode URL-safe base64 (with or without padding) to bytes.
 *
 * @param value - Base64url string.
 * @returns Decoded bytes.
 */
export function base64UrlToBytes(value: string): Uint8Array {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/");
  const padLen = (4 - (padded.length % 4)) % 4;
  return base64ToBytes(padded + "=".repeat(padLen));
}
