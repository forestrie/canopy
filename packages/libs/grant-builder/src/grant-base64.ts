/**
 * Base64 grant wire helpers for the `Authorization: Forestrie-Grant <base64>`
 * header content (grants.md §3).
 */

/** Decode standard or URL-safe base64 grant header content to bytes. */
export function base64ToBytes(b64: string): Uint8Array {
  const normalized = b64.replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(normalized);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

/** Encode grant COSE Sign1 wire bytes as the Forestrie-Grant header base64. */
export function bytesToForestrieGrantBase64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]!);
  return btoa(s);
}
